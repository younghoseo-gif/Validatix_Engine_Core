require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generatePRD(idea, marketData) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are "The Architect", a world-class software engineer and product manager.
Based on the [User's Idea] and [Phase 1 Market Research Data], design a highly structured Product Requirements Document (PRD) and System Architecture.

[Language Requirement: CRITICAL]
Identify the primary language used in the [User's Idea]. You MUST write the ENTIRE PRD in that EXACT SAME LANGUAGE. If Korean, output professional Korean.

[User's Idea]
"${idea}"

[Phase 1 Market Research Data]
"${marketData || 'No specific market data provided. Proceed with general assumptions.'}"

[Required Output Structure]
## System Output // Phase 2: PRD & Architecture Validation

### 1. Product Vision & MVP Features (제품 비전 및 최소 기능 구현 명세)
- (Define the exact MVP features required for launch to dominate the market)

### 2. Information Architecture & UI/UX (정보 구조 및 UI/UX 설계)
- (List necessary pages/screens, routing paths, and core UI components)

### 3. Database Schema & API Endpoints (데이터베이스 스키마 및 REST API 구조)
- (Propose core data models in JSON/NoSQL format and exact API endpoints needed)

Maintain a strictly analytical, engineering-focused tone. Do not use filler words. Base your design on modern, scalable global infrastructure.`;

        const result = await model.generateContent(prompt);
        return result.response.text();
    } catch (error) {
        console.error("Error generating PRD:", error);
        return "PRD Generation failed due to AI Engine Error.";
    }
}

app.post('/api/plan', async (req, res) => {
    const { idea, marketData } = req.body;

    if (!idea) {
        return res.status(400).json({ error: "Idea is required for planning." });
    }

    console.log(`[Planning Started] Idea: ${idea}`);

    const prdResult = await generatePRD(idea, marketData);

    res.json({
        idea: idea,
        prd: prdResult
    });
});

const PORT = process.env.PORT || 3001;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`[Validatix Planning Module] running on port ${PORT}`);
    });
}
module.exports = app;