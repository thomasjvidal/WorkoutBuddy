import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import bodyParser from 'body-parser';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from "@google/generative-ai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// Base de dados simples para fallback (Food101 labels -> Macros aproximados por 100g)
const FOOD_DB = {
    'pizza': { cal: 266, p: 11, c: 33, f: 10 },
    'hamburger': { cal: 295, p: 17, c: 24, f: 14 },
    'sushi': { cal: 140, p: 5, c: 28, f: 1 },
    'salad': { cal: 30, p: 1, c: 4, f: 0 },
    'steak': { cal: 271, p: 26, c: 0, f: 19 },
    'chicken_wings': { cal: 203, p: 30, c: 0, f: 8 },
    'spaghetti_bolognese': { cal: 150, p: 7, c: 20, f: 5 },
    'chocolate_cake': { cal: 371, p: 5, c: 53, f: 15 },
    'default': { cal: 150, p: 10, c: 15, f: 5 }
};

app.post('/api/analyze-image', async (req, res) => {
    try {
        let { image, audio, apiKey, provider, endpoint } = req.body;

        // Prioriza chaves do ambiente se não fornecidas pelo cliente
        if (!apiKey) {
            if (provider === 'openai') apiKey = process.env.OPENAI_API_KEY;
            else if (provider === 'gemini') apiKey = process.env.GEMINI_API_KEY;
            else if (provider === 'huggingface') apiKey = process.env.HF_API_KEY;

            // Auto-detecção
            if (!provider) {
                if (process.env.GEMINI_API_KEY) {
                    provider = 'gemini';
                    apiKey = process.env.GEMINI_API_KEY;
                } else if (process.env.OPENAI_API_KEY) {
                    provider = 'openai';
                    apiKey = process.env.OPENAI_API_KEY;
                } else {
                    provider = 'huggingface';
                    apiKey = process.env.HF_API_KEY;
                }
            }
        }

        console.log(`Analisando com ${provider}...`);

        // --- GOOGLE GEMINI (Grátis e Inteligente) ---
        if (provider === 'gemini') {
            if (!apiKey) throw new Error('Chave Gemini não configurada (.env)');

            const genAI = new GoogleGenerativeAI(apiKey);
            // Gemini 1.5 Flash é ótimo para multimodais e rápido
            let modelName = "gemini-1.5-flash";
            let model = genAI.getGenerativeModel({ model: modelName });

            let prompt = 'Você é um nutricionista. Analise a imagem e identifique os alimentos, estime o peso (em gramas) e calcule calorias e macros. Retorne APENAS um JSON: {"items":[{"name":"Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}],"confidence":0.9}';

            const parts = [];

            if (audio) {
                if (req.body.search) {
                    prompt = 'Você é um nutricionista. Analise o áudio. Se o usuário listou vários alimentos (ex: "arroz, feijão e frango"), identifique cada um deles separadamente com seus macros estimados para uma porção média. Se o usuário falou apenas um alimento genérico (ex: "maçã"), forneça 3 a 5 variações ou tamanhos comuns. Retorne APENAS um JSON: {"options":[{"name":"Nome do Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}]}.';
                } else {
                    prompt = 'Você é um nutricionista. Analise o áudio com a descrição da refeição. Identifique os alimentos mencionados, estime o peso (em gramas) se não especificado (use porções médias), e calcule calorias e macros. Retorne APENAS um JSON: {"items":[{"name":"Alimento","grams":100,"calories":0,"protein":0,"carbs":0,"fat":0}],"confidence":0.9}';
                }
                parts.push(prompt);

                parts.push({
                    inlineData: {
                        data: audio,
                        mimeType: "audio/webm"
                    }
                });
            } else if (image) {
                // Remove header do base64 se existir
                const base64Data = image.includes('base64,') ? image.split('base64,')[1] : image;
                parts.push(prompt);
                parts.push({
                    inlineData: {
                        data: base64Data,
                        mimeType: "image/jpeg"
                    }
                });
            } else {
                throw new Error('Nenhuma imagem ou áudio fornecido.');
            }

            let result;
            try {
                result = await model.generateContent(parts);
            } catch (e) {
                console.log(`Erro com ${modelName}: ${e.message}`);

                // Fallback strategies logic retained if needed, but simplified for brevity
                // If 1.5 fails, we might try pro or earlier versions, but 1.5 is standard now.
                if (e.message.includes('404') || e.message.includes('not found')) {
                    const fallback = "gemini-1.5-flash";
                    console.log(`Tentando fallback ${fallback}`);
                    const model2 = genAI.getGenerativeModel({ model: fallback });
                    result = await model2.generateContent(parts);
                } else {
                    throw e;
                }
            }

            const response = await result.response;
            const text = response.text();

            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return res.json({ provider: 'gemini', result: JSON.parse(cleanText) });
        }

        // --- OPENAI / COMPATIBLE ---
        if (provider === 'openai' || provider === 'custom') {
            if (!apiKey) throw new Error('Chave de API não configurada no servidor (.env)');

            const apiUrl = endpoint || 'https://api.openai.com/v1/chat/completions';
            const model = provider === 'openai' ? 'gpt-4o-mini' : (req.body.model || 'gpt-3.5-turbo');

            const payload = {
                model: model,
                messages: [
                    {
                        role: 'system',
                        content: 'Você é um nutricionista expert. Identifique os alimentos na imagem, estime o peso em gramas visualmente e calcule as calorias e macros. Retorne APENAS um JSON estrito com o seguinte formato, sem markdown ou explicações: {"items":[{"name":"nome do alimento","grams":150,"calories":200,"protein":30,"carbs":10,"fat":5}],"confidence":0.95}'
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'text', text: 'Analise este prato.' },
                            { type: 'image_url', image_url: { url: image } }
                        ]
                    }
                ],
                max_tokens: 500,
                temperature: 0.1
            };

            const response = await fetch(apiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey}`
                },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Erro API ${provider}: ${response.status} - ${errText}`);
            }

            const json = await response.json();
            const content = json.choices?.[0]?.message?.content || '{}';
            const cleanContent = content.replace(/```json/g, '').replace(/```/g, '').trim();

            return res.json({
                provider: provider,
                result: JSON.parse(cleanContent)
            });
        }

        // --- HUGGING FACE (Fallback) ---
        console.log('Usando fallback Hugging Face...');
        const headers = {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
        };

        // Classificação Food101
        const clsRes = await fetch('https://api-inference.huggingface.co/models/nateraw/food101', {
            method: 'POST',
            headers,
            body: JSON.stringify({ inputs: image })
        });

        let items = [];
        let confidence = 0.5;

        if (clsRes.ok) {
            const classification = await clsRes.json().catch(() => []);
            // Pega o top 3
            const top3 = Array.isArray(classification) ? classification.slice(0, 3) : [];

            if (top3.length > 0) {
                confidence = top3[0].score;
                items = top3.map(item => {
                    const label = item.label;
                    // Tenta achar macros aproximados ou usa default
                    const ref = Object.entries(FOOD_DB).find(([k]) => label.includes(k))?.[1] || FOOD_DB.default;
                    const grams = 100; // Estimativa padrão

                    return {
                        name: label.replace(/_/g, ' '),
                        grams: grams,
                        calories: Math.round(ref.cal * (grams / 100)),
                        protein: Math.round(ref.p * (grams / 100)),
                        carbs: Math.round(ref.c * (grams / 100)),
                        fat: Math.round(ref.f * (grams / 100))
                    };
                });
            }
        } else {
            console.warn('HF Food101 falhou, tentando apenas caption...');
        }

        // Se não conseguiu nada com Food101, tenta captioning para pelo menos dar um nome
        if (items.length === 0) {
            const blipRes = await fetch('https://api-inference.huggingface.co/models/Salesforce/blip-image-captioning-large', {
                method: 'POST',
                headers,
                body: JSON.stringify({ inputs: image })
            });

            if (blipRes.ok) {
                const blipJson = await blipRes.json();
                const text = Array.isArray(blipJson) ? blipJson[0]?.generated_text : blipJson?.generated_text;
                if (text) {
                    items.push({
                        name: text,
                        grams: 100,
                        ...FOOD_DB.default
                    });
                }
            }
        }

        if (items.length === 0) {
            throw new Error('Não foi possível identificar alimentos na imagem.');
        }

        res.json({
            provider: 'huggingface',
            result: {
                items: items,
                confidence: confidence
            }
        });

    } catch (error) {
        console.error('Erro no proxy:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Servidor rodando em http://localhost:${PORT}`);
});
