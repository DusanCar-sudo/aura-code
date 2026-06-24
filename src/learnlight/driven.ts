import { HistoryMessage, LLMProvider } from '../providers/types.js';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function generateDrivenMaterial(topic: string, level: string, provider: LLMProvider, projectRoot: string): Promise<string> {
  const systemPrompt = `You are an expert English curriculum designer. Create a full lesson material similar to "Learnlight" materials for the given topic and level.

Topic: ${topic}
Level: ${level}

Output the material as a strict JSON object with this exact structure (no markdown, just JSON):
{
  "title": "A catchy title for the lesson",
  "subtitle": "By the end of the session, you will be able to...",
  "level": "${level}",
  "beforeWeStart": {
    "keyLanguage": ["word1", "word2", "word3"],
    "questions": ["Question 1", "Question 2"]
  },
  "vocabularyBoost": {
    "title": "Vocabulary Section Title",
    "words": ["word4 - definition/context", "word5 - definition/context"],
    "questions": ["Discussion question 1", "Discussion question 2"]
  },
  "shareExperience": {
    "title": "Share your experience",
    "questions": ["Experience question 1", "Experience question 2"]
  },
  "discoverAndLearn": {
    "title": "Discover and learn section",
    "exercises": ["Exercise 1 description", "Exercise 2 description"]
  },
  "spotlight": {
    "title": "Spotlight (Tips/Tricks)",
    "tips": ["Tip 1", "Tip 2", "Tip 3"]
  },
  "yourTurn": {
    "title": "Your turn (Roleplay/Practice)",
    "scenarios": ["Scenario 1", "Scenario 2"]
  }
}`;

  const history: HistoryMessage[] = [
    { role: 'user', content: 'Generate the lesson material.' }
  ];

  let text = '';
  for await (const chunk of provider.stream(systemPrompt, history, [])) {
    if (chunk.type === 'text') text += chunk.text;
    if (chunk.type === 'done') break;
  }

  let jsonText = text.trim();
  if (jsonText.startsWith('```json')) {
    jsonText = jsonText.replace(/^```json\n/, '').replace(/\n```$/, '');
  } else if (jsonText.startsWith('```')) {
    jsonText = jsonText.replace(/^```\n/, '').replace(/\n```$/, '');
  }

  const lessonData = JSON.parse(jsonText);
  const jsonPath = path.join(projectRoot, 'temp_lesson.json');
  fs.writeFileSync(jsonPath, JSON.stringify(lessonData, null, 2));

  const pyScript = path.join(projectRoot, 'generate_lesson_pdf.py');
  const safeTitle = lessonData.title.replace(/[^a-zA-Z0-9]/g, '_');
  const outPdf = path.join(projectRoot, `Lesson_${safeTitle}.pdf`);
  
  await execAsync(`python3 "${pyScript}" "${jsonPath}" "${outPdf}"`);
  
  try {
    fs.unlinkSync(jsonPath);
  } catch(e) {}
  
  return outPdf;
}
