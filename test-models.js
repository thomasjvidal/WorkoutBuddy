
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";

dotenv.config();

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY not found in .env");
      return;
    }
    console.log(`API Key loaded: ${apiKey.substring(0, 4)}... (length: ${apiKey.length})`);
  
    // Try REST API directly to list models
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();
        
        if (!response.ok) {
            console.error("API Error:", JSON.stringify(data, null, 2));
        } else {
            console.log("Available models:");
            if (data.models) {
                data.models.forEach(m => {
                    if (m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent")) {
                        console.log(`- ${m.name.replace('models/', '')}`);
                    }
                });
            } else {
                console.log("No models found in response.");
            }
        }
    } catch (e) {
        console.error("Fetch error:", e);
    }
}

listModels();
