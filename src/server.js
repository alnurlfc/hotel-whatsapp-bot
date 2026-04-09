const express = require("express");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

dotenv.config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const OPENAI_FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-4o-mini";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 12000);
const HOTEL_NAME = process.env.HOTEL_NAME || "Our Hotel";
const ADMIN_PHONE_E164 = process.env.ADMIN_PHONE_E164 || "";
const ENABLE_GOOGLE_SHEETS_LOGGING = process.env.ENABLE_GOOGLE_SHEETS_LOGGING === "true";
const GOOGLE_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "";
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "";
const GOOGLE_PRIVATE_KEY = (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
const GOOGLE_SHEET_NAME = process.env.GOOGLE_SHEET_NAME || "Logs";

const knowledgeBasePath = path.join(__dirname, "..", "data", "knowledge-base.json");
const knowledgeBase = loadKnowledgeBase(knowledgeBasePath);
const guestLanguagePrefs = new Map();
const localizedMessages = {
  ru: {
    adminRequest: "Передаю ваш запрос администратору. Сотрудник скоро свяжется с вами.",
    fallbackHelp: "Если нужно, уточни детали, и я помогу дальше.",
    noAiNoFaq:
      "Я уточню этот вопрос у администратора и вернусь с ответом. Можете также написать на ресепшн.",
    aiEmpty: "Извините, сейчас не удалось сформировать ответ. Попробуйте еще раз.",
    aiErrorWithFaq: "Если нужно, могу позвать сотрудника ресепшн.",
    aiErrorNoFaq:
      "Я пока не нашел точный ответ. Уточните, пожалуйста: вас интересует check-in/out, трансфер, парковка, завтрак или багаж?",
    aiLangInstruction: "Answer in Russian."
  },
  cs: {
    adminRequest: "Predavam vas pozadavek recepci. Kolega se vam brzy ozve.",
    fallbackHelp: "Pokud potrebujete, upresnete prosim detaily a rad pomohu dal.",
    noAiNoFaq: "Tento dotaz overim na recepci a brzy se ozvu s odpovedi.",
    aiEmpty: "Omlouvame se, odpoved se nepodarilo vytvorit. Zkuste to prosim znovu.",
    aiErrorWithFaq: "Pokud chcete, mohu zavolat kolegu z recepce.",
    aiErrorNoFaq:
      "Zatim jsem nenasel presnou odpoved. Upresnete prosim, zda jde o check-in/out, transfer, parkovani, snidani nebo zavazadla.",
    aiLangInstruction: "Answer in Czech."
  },
  en: {
    adminRequest: "I am forwarding your request to reception. A staff member will contact you shortly.",
    fallbackHelp: "If needed, please share more details and I will help further.",
    noAiNoFaq:
      "I will confirm this question with reception and get back to you. You can also contact reception directly.",
    aiEmpty: "Sorry, I could not generate a reply right now. Please try again.",
    aiErrorWithFaq: "If needed, I can connect you with reception staff.",
    aiErrorNoFaq:
      "I could not find an exact answer yet. Please clarify if this is about check-in/out, transfer, parking, breakfast, or luggage.",
    aiLangInstruction: "Answer in English."
  }
};

app.get("/", (_, res) => {
  res.send("WhatsApp bot is running.");
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  const entries = req.body.entry || [];

  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      const value = change.value || {};
      const messages = value.messages || [];

      for (const msg of messages) {
        const from = msg.from;
        const incomingText = extractIncomingText(msg);

        if (!from || !incomingText) {
          continue;
        }

        try {
          const selectedLang = parseLanguageSelection(msg, incomingText);
          if (selectedLang) {
            guestLanguagePrefs.set(from, selectedLang);
            const confirmByLang = {
              ru: "Язык установлен: Русский. Чем могу помочь?",
              en: "Language set to English. How can I help you?",
              cs: "Jazyk nastaven na cestinu. Jak vam mohu pomoci?"
            };
            await sendWhatsAppMessage(from, confirmByLang[selectedLang]);
            continue;
          }

          const savedLang = guestLanguagePrefs.get(from);
          if (!savedLang) {
            await sendLanguageSelectionPrompt(from);
            continue;
          }

          const lang = savedLang;
          const replyText = await buildReply(incomingText, lang);
          await appendLogToGoogleSheets({
            guestPhone: from,
            question: incomingText,
            answer: replyText
          });

          await sendWhatsAppMessage(from, replyText);

          if (shouldEscalate(incomingText)) {
            await notifyAdmin(from, incomingText);
          }
        } catch (err) {
          console.error(
            "Message processing error:",
            JSON.stringify({
              from,
              incomingText,
              error: err.message
            })
          );
        }
      }
    }
  }

  return res.sendStatus(200);
});

function extractIncomingText(msg) {
  if (msg.text?.body) {
    return msg.text.body.trim();
  }
  if (msg.button?.text) {
    return msg.button.text.trim();
  }
  if (msg.button?.payload) {
    return msg.button.payload.trim();
  }
  if (msg.interactive?.button_reply?.title) {
    return msg.interactive.button_reply.title.trim();
  }
  if (msg.interactive?.button_reply?.id) {
    return msg.interactive.button_reply.id.trim();
  }
  return "";
}

function parseLanguageSelection(msg, incomingText) {
  const raw = normalize(
    [
      incomingText,
      msg.button?.payload || "",
      msg.button?.text || "",
      msg.interactive?.button_reply?.id || "",
      msg.interactive?.button_reply?.title || ""
    ].join(" ")
  );

  if (["ru", "рус", "russian", "lang_ru"].some((token) => raw.includes(token))) {
    return "ru";
  }
  if (["en", "eng", "english", "lang_en"].some((token) => raw.includes(token))) {
    return "en";
  }
  if (["cs", "cz", "cestina", "cesky", "lang_cs"].some((token) => raw.includes(token))) {
    return "cs";
  }
  return null;
}

async function sendLanguageSelectionPrompt(to) {
  await sendWhatsAppInteractiveButtons(
    to,
    "Please choose your language / Vyberte jazyk / Выберите язык",
    [
      { id: "lang_ru", title: "RU" },
      { id: "lang_en", title: "EN" },
      { id: "lang_cs", title: "CZ" }
    ]
  );
}

function loadKnowledgeBase(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed.faq || [];
  } catch (error) {
    console.error("Failed to load knowledge base:", error.message);
    return [];
  }
}

function normalize(text) {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .trim();
}

function scoreFaq(question, faqItem) {
  const normalizedQuestion = normalize(question);
  const questionWords = normalizedQuestion.split(/\s+/).filter(Boolean);
  const keywordHits = (faqItem.keywords || []).filter((keyword) =>
    normalizedQuestion.includes(normalize(keyword))
  ).length;

  const wordHits = questionWords.filter((word) => {
    return normalize(faqItem.question).includes(word) || normalize(getFaqSearchText(faqItem)).includes(word);
  }).length;

  return keywordHits * 5 + wordHits;
}

function findBestFaq(question) {
  let bestMatch = null;

  for (const faqItem of knowledgeBase) {
    const score = scoreFaq(question, faqItem);
    if (!bestMatch || score > bestMatch.score) {
      bestMatch = { item: faqItem, score };
    }
  }

  if (!bestMatch || bestMatch.score < 2) {
    return null;
  }

  return bestMatch;
}

function isShortIntentQuery(text) {
  const words = normalize(text).split(/\s+/).filter(Boolean);
  return words.length <= 3;
}

function getFaqSearchText(faqItem) {
  return [faqItem.answer, faqItem.answer_ru, faqItem.answer_cs, faqItem.answer_en]
    .filter(Boolean)
    .join(" ");
}

function getLocalizedFaqAnswer(faqItem, lang) {
  const byLang = {
    ru: faqItem.answer_ru,
    cs: faqItem.answer_cs,
    en: faqItem.answer_en
  };
  return byLang[lang] || faqItem.answer_en || faqItem.answer || "";
}

function findTopFaqs(question, limit = 3) {
  const scored = knowledgeBase
    .map((item) => ({ item, score: scoreFaq(question, item) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return scored;
}

async function buildReply(incomingText, lang) {
  const t = localizedMessages[lang];

  if (isAdminRequest(incomingText)) {
    return t.adminRequest;
  }

  const bestMatch = findBestFaq(incomingText);
  const fallbackFaq = bestMatch?.item || null;
  const topFaqs = findTopFaqs(incomingText, 3);

  if (bestMatch && isShortIntentQuery(incomingText) && bestMatch.score >= 4) {
    return `${getLocalizedFaqAnswer(bestMatch.item, lang)}\n\n${t.fallbackHelp}`;
  }

  if (!OPENAI_API_KEY) {
    if (fallbackFaq) {
      return `${getLocalizedFaqAnswer(fallbackFaq, lang)}\n\n${t.fallbackHelp}`;
    }
    return `${t.noAiNoFaq}\n\n${buildSuggestionText(topFaqs, lang)}`;
  }

  try {
    const aiReply = await generateAiReply(incomingText, fallbackFaq, topFaqs, lang);
    return aiReply || t.aiEmpty;
  } catch (error) {
    console.error("AI reply error:", error.message);
    if (fallbackFaq) {
      return `${getLocalizedFaqAnswer(fallbackFaq, lang)}\n\n${t.aiErrorWithFaq}`;
    }
    return `${t.aiErrorNoFaq}\n\n${buildSuggestionText(topFaqs, lang)}`;
  }
}

async function generateAiReply(question, matchedFaq, topFaqs, lang) {
  const t = localizedMessages[lang];
  const kbContext = knowledgeBase
    .slice(0, 40)
    .map((faq, index) => `${index + 1}. Q: ${faq.question}\nA: ${getLocalizedFaqAnswer(faq, lang)}`)
    .join("\n\n");

  const seedAnswerByLang = {
    ru: matchedFaq
      ? `Ближайший найденный ответ в базе: ${getLocalizedFaqAnswer(matchedFaq, "ru")}`
      : "Подходящий прямой ответ в базе не найден.",
    cs: matchedFaq
      ? `Nejblizsi nalezena odpoved v databazi: ${getLocalizedFaqAnswer(matchedFaq, "cs")}`
      : "V databazi nebyla nalezena prima odpoved.",
    en: matchedFaq
      ? `Closest answer found in the knowledge base: ${getLocalizedFaqAnswer(matchedFaq, "en")}`
      : "No direct answer found in the knowledge base."
  };
  const seedAnswer = seedAnswerByLang[lang] || seedAnswerByLang.en;
  const relevantContext = topFaqs
    .map((entry, index) => `${index + 1}. Q: ${entry.item.question}\nA: ${getLocalizedFaqAnswer(entry.item, lang)}`)
    .join("\n\n");

  const modelsToTry = [OPENAI_MODEL, OPENAI_FALLBACK_MODEL];
  let lastError = null;

  for (const model of modelsToTry) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model,
            temperature: 0.2,
            messages: [
              {
                role: "system",
                content:
                  `You are a hotel concierge assistant for ${HOTEL_NAME}. ` +
                  `${t.aiLangInstruction} Answer briefly and politely. ` +
                  "Use only facts from the provided hotel knowledge base. " +
                  "If information is missing, ask one short clarifying question or say you will clarify with reception."
              },
              {
                role: "system",
                content: `Most relevant FAQ entries:\n\n${relevantContext || "None"}`
              },
              {
                role: "system",
                content: `Full hotel knowledge base:\n\n${kbContext}`
              },
              {
                role: "system",
                content: seedAnswer
              },
              {
                role: "user",
                content: question
              }
            ]
          })
        });

        if (!response.ok) {
          const errorBody = await response.text();
          throw new Error(`OpenAI API error (${model}, try ${attempt}): ${response.status} ${errorBody}`);
        }

        const data = await response.json();
        const text = data.choices?.[0]?.message?.content?.trim();
        if (text) {
          return text;
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("OpenAI returned empty response");
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

function buildSuggestionText(topFaqs, lang) {
  if (!topFaqs.length) {
    return "";
  }

  const suggestions = topFaqs.map((entry) => `- ${entry.item.question}`).join("\n");
  const titleByLang = {
    ru: "Возможно, вы имели в виду:",
    cs: "Mozna jste mysleli:",
    en: "You may be asking about:"
  };

  return `${titleByLang[lang] || titleByLang.en}\n${suggestions}`;
}

function isAdminRequest(text) {
  const normalized = normalize(text);
  const triggers = [
    "администратор",
    "оператор",
    "человек",
    "ресепшн",
    "позови сотрудника",
    "recepce",
    "operator",
    "clovek",
    "zivy operator",
    "prosim recepci",
    "surname",
    "full name",
    "booked breakfast",
    "breakfast included",
    "manager",
    "human"
  ];

  return triggers.some((trigger) => normalized.includes(trigger));
}

function detectLanguage(text) {
  const sample = text.toLowerCase();
  if (/[а-яё]/i.test(sample)) {
    return "ru";
  }

  if (/[áčďéěíňóřšťúůýž]/i.test(sample)) {
    return "cs";
  }

  const czechMarkers = [
    "dobr",
    "prosim",
    "recepce",
    "snídan",
    "snidan",
    "parkovani",
    "zavazad",
    "ubytov",
    "odjezd",
    "prijezd",
    "rezervace",
    "letiste",
    "masaz",
    "check-in",
    "check-out",
    "kdy",
    "kde",
    "jak",
    "muzu",
    "muzu",
    "prosim",
    "dekuji",
    "dekuji",
    "děkuji"
  ];
  if (czechMarkers.some((marker) => sample.includes(marker))) {
    return "cs";
  }

  return "en";
}

function shouldEscalate(text) {
  const normalized = normalize(text);
  const urgentWords = [
    "срочно",
    "шум",
    "не работает",
    "жалоба",
    "проблема",
    "пожар",
    "протечка",
    "urgent",
    "complaint"
  ];

  return isAdminRequest(text) || urgentWords.some((word) => normalized.includes(word));
}

async function notifyAdmin(guestPhone, guestQuestion) {
  if (!ADMIN_PHONE_E164) {
    return;
  }

  const adminText =
    `ALERT ${HOTEL_NAME}\n` +
    `Guest: ${guestPhone}\n` +
    `Message: ${guestQuestion}\n` +
    "Please contact the guest.";

  try {
    await sendWhatsAppMessage(ADMIN_PHONE_E164, adminText);
  } catch (error) {
    console.error("Admin notify failed:", error.message);
  }
}

async function appendLogToGoogleSheets({ guestPhone, question, answer }) {
  if (!ENABLE_GOOGLE_SHEETS_LOGGING) {
    return;
  }

  if (!GOOGLE_SHEETS_ID || !GOOGLE_SERVICE_ACCOUNT_EMAIL || !GOOGLE_PRIVATE_KEY) {
    console.error("Google Sheets logging is enabled but env vars are incomplete.");
    return;
  }

  try {
    const auth = new google.auth.JWT({
      email: GOOGLE_SERVICE_ACCOUNT_EMAIL,
      key: GOOGLE_PRIVATE_KEY,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheets = google.sheets({ version: "v4", auth });
    await sheets.spreadsheets.values.append({
      spreadsheetId: GOOGLE_SHEETS_ID,
      range: `${GOOGLE_SHEET_NAME}!A:F`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            new Date().toISOString(),
            HOTEL_NAME,
            guestPhone,
            question,
            answer,
            shouldEscalate(question) ? "YES" : "NO"
          ]
        ]
      }
    });
  } catch (error) {
    console.error("Google Sheets append failed:", error.message);
  }
}

async function sendWhatsAppMessage(to, text) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: { body: text }
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Meta API error: ${response.status} ${errorBody}`);
  }
}

async function sendWhatsAppInteractiveButtons(to, bodyText, buttons) {
  if (!ACCESS_TOKEN || !PHONE_NUMBER_ID) {
    throw new Error("Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID");
  }

  const response = await fetch(
    `https://graph.facebook.com/v22.0/${PHONE_NUMBER_ID}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: bodyText },
          action: {
            buttons: buttons.map((button) => ({
              type: "reply",
              reply: { id: button.id, title: button.title }
            }))
          }
        }
      })
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Meta API error: ${response.status} ${errorBody}`);
  }
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
