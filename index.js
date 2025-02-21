const express = require('express');
const axios = require('axios');
require('dotenv').config();
const home = require("./routes/home");

const app = express();
app.use(express.json());

// In-memory trackers (same as before)
const generationCountsPerUser = {};
const userGenerationCounts = {};

// Tracking functions (same as before)
function canGenerateChecklistForUser(userId, taskId) {
  const today = new Date().toISOString().split('T')[0];
  if (!generationCountsPerUser[userId] || generationCountsPerUser[userId].date !== today) {
    generationCountsPerUser[userId] = { date: today, counts: {} };
  }
  const count = generationCountsPerUser[userId].counts[taskId] || 0;
  const canGenerate = count < 3;
  console.log(`User ${userId} for task ${taskId} generation count for ${today}: ${count} (allowed: ${canGenerate})`);
  return canGenerate;
}

function updateGenerationCountForUser(userId, taskId) {
  const today = new Date().toISOString().split('T')[0];
  if (!generationCountsPerUser[userId] || generationCountsPerUser[userId].date !== today) {
    generationCountsPerUser[userId] = { date: today, counts: {} };
  }
  generationCountsPerUser[userId].counts[taskId] = (generationCountsPerUser[userId].counts[taskId] || 0) + 1;
  console.log(`Updated generation count for user ${userId} for task ${taskId}: ${generationCountsPerUser[userId].counts[taskId]}`);
}

function canGenerateUserChecklist(userId, taskId) {
  const today = new Date().toISOString().split('T')[0];
  if (!userGenerationCounts[userId] || userGenerationCounts[userId].date !== today) {
    userGenerationCounts[userId] = { date: today, tasks: new Set() };
    console.log(`Reset user generation tracker for user ${userId} for date ${today}`);
    return true;
  }
  if (userGenerationCounts[userId].tasks.has(taskId)) {
    console.log(`User ${userId} has already generated a checklist for task ${taskId} today.`);
    return true;
  }
  const canGenerate = userGenerationCounts[userId].tasks.size < 5;
  console.log(`User ${userId} has generated checklists for ${userGenerationCounts[userId].tasks.size} unique tasks today (allowed: ${canGenerate}).`);
  return canGenerate;
}

function updateUserGenerationCount(userId, taskId) {
  const today = new Date().toISOString().split('T')[0];
  if (!userGenerationCounts[userId] || userGenerationCounts[userId].date !== today) {
    userGenerationCounts[userId] = { date: today, tasks: new Set() };
    console.log(`Reset user generation tracker for user ${userId} for date ${today}`);
  }
  userGenerationCounts[userId].tasks.add(taskId);
  console.log(`User ${userId} checklist tasks for ${today}: [${[...userGenerationCounts[userId].tasks].join(', ')}]`);
}

// Increase Axios timeout and add retry mechanism
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is not defined in the environment!");
  process.exit(1);
}
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// Helper: Remove markdown code fences
function extractJson(text) {
  if (text.startsWith("```json")) {
    text = text.substring("```json".length).trim();
    if (text.endsWith("```")) {
      text = text.substring(0, text.length - "```".length).trim();
    }
  }
  return text;
}

// Helper: Escape non-ASCII characters
function escapeNonAscii(s) {
  return s
    .split('')
    .map(c => c.charCodeAt(0) > 127 ? "\\u" + ("000" + c.charCodeAt(0).toString(16)).slice(-4) : c)
    .join('');
}

// Helper: Call Gemini API with retries and timeout
async function callGeminiAPI(payload, retries = 2, delayMs = 1000) {
  try {
    const response = await axios.post(GEMINI_API_URL, payload, {
      headers: { "Content-Type": "application/json; charset=utf-8" },
      timeout: 120000 // 120 seconds timeout
    });
    return response.data;
  } catch (err) {
    if (retries > 0) {
      console.log(`Retrying Gemini API call in ${delayMs} ms. Error: ${err.toString()}`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return callGeminiAPI(payload, retries - 1, delayMs * 2);
    } else {
      throw err;
    }
  }
}
app.use("/home", home);

app.post('/generate-checklist', async (req, res) => {
  try {
    const data = req.body;
    const { userId, taskId, taskTitle, taskDescription, category = "General", 
      workHours = { start: "09:00", end: "17:00" }, 
      notificationHours = { start: "08:00", end: "20:00" }, 
      morningPeak = 50, afternoonPeak = 50, language = "en" } = data;

    if (!userId) {
      return res.status(400).json({ error: "userId is required" });
    }
    if (!taskId) {
      return res.status(400).json({ error: "taskId is required" });
    }

    // Check limits.
    if (!canGenerateChecklistForUser(userId, taskId)) {
      return res.status(429).json({ error: "Checklist generation limit reached for this task today for this user" });
    }
    if (!canGenerateUserChecklist(userId, taskId)) {
      return res.status(429).json({ error: "User has reached the daily checklist generation limit for new tasks" });
    }

    // Enforce character limits.
    const MAX_TITLE = 50;
    const MAX_DESC = 150;
    const MAX_CATEGORY = 30;
    const trimmedTitle = taskTitle.length > MAX_TITLE ? taskTitle.substring(0, MAX_TITLE) : taskTitle;
    const trimmedDescription = taskDescription.length > MAX_DESC ? taskDescription.substring(0, MAX_DESC) : taskDescription;
    const trimmedCategory = category.length > MAX_CATEGORY ? category.substring(0, MAX_CATEGORY) : category;

    // Build prompt.
    const prompt = `You are a productivity assistant that creates detailed checklists to help users complete their tasks.
  Title: "${trimmedTitle}"
  Description: "${trimmedDescription}"
  
  Additional details:
  - Work Hours: ${workHours.start} to ${workHours.end}
  - Notification Hours: ${notificationHours.start} to ${notificationHours.end}
  - Morning Productivity Peak: ${morningPeak}%
  - Afternoon Productivity Peak: ${afternoonPeak}%
  - Category: "${trimmedCategory}"
  
  Based on the above, generate a detailed checklist in valid JSON format. The JSON object must have a key 'checklist' that maps to an array of checklist items. Each checklist item should be an object with the following keys:
    - 'description': A clear, concise description of the step or sub-task.
    - 'estimatedTime': An estimated duration in minutes for that step.
    - 'isCompleted': A boolean value, set to false.
  
  Do not include any extra text or explanation outside the JSON.
  Also, generate the checklist in the same language as the task title and description.`;

    // Update counters.
    updateGenerationCountForUser(userId, taskId);
    updateUserGenerationCount(userId, taskId);

    // Build payload.
    const payload = {
      contents: [{
        parts: [{ text: prompt }]
      }]
    };

    // Call Gemini API with retry.
    const apiResponse = await callGeminiAPI(payload);
    
    const candidates = apiResponse.candidates;
    if (!candidates || candidates.length === 0) {
      return res.status(500).json({ error: "No candidates returned", rawOutput: apiResponse });
    }

    const candidate = candidates[0];
    const generatedText = candidate.content?.parts?.[0]?.text || "";
    if (!generatedText) {
      return res.status(500).json({ error: "No text generated", rawOutput: apiResponse });
    }

    // Clean and check response.
    const cleanedText = extractJson(generatedText);
    if (!cleanedText || cleanedText.length < 10) {
      console.error("Received truncated response:", cleanedText);
      return res.status(500).json({ error: "Received incomplete API response", rawOutput: cleanedText });
    }

    let finalResult;
    try {
      finalResult = JSON.parse(cleanedText);
    } catch (jsonErr) {
      console.error("JSON parsing error:", jsonErr, "Raw output:", cleanedText);
      return res.status(500).json({ error: "Failed to parse API output", rawOutput: cleanedText });
    }

    const finalJson = JSON.stringify(finalResult);
    const escapedJson = escapeNonAscii(finalJson);
    res.status(200).send(escapedJson);
  } catch (err) {
    console.log(GEMINI_API_KEY);
    res.status(500).json({ error: "Error calling LLM API: " + err.toString() });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => console.log(`Listening to port ${port}`));