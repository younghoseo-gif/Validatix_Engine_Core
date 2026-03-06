require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function generateBackendCode(idea, prd) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are "The Architect", a world-class Backend Engineer.
Your task is to translate the [User's Idea] and [Phase 2 PRD] into actual, production-ready Node.js (Express) code.

[User's Idea]
"${idea}"

[Phase 2 PRD]
"${prd}"

[Execution Requirements: CRITICAL]
1. Write a SINGLE, complete, and functional Node.js file (server.js) that implements the core REST API endpoints defined in the PRD.
2. Use Express.js framework.
3. Include basic error handling and mock data/dummy responses based on the database schema from the PRD, so the API is immediately testable.
4. Output ONLY the raw JavaScript code. Do NOT wrap it in markdown blockticks (\`\`\`javascript ... \`\`\`). Do NOT add any explanations. Start immediately with "const express" or "require".`;

        const result = await model.generateContent(prompt);
        let code = result.response.text();
        
        // 마크다운 잔재 제거 로직 (안전장치)
        if (code.startsWith('```')) {
            const lines = code.split('\n');
            lines.shift();
            if (lines[lines.length - 1].trim().startsWith('```')) lines.pop();
            code = lines.join('\n');
        }

        return code;
    } catch (error) {
        console.error("Error generating Backend code:", error);
        throw error;
    }
}

app.post('/api/code', async (req, res) => {
    const { idea, prd } = req.body;

    if (!idea || !prd) {
        return res.status(400).json({ error: "Idea and PRD are required." });
    }

    console.log(`[Backend Code Generation Started] Target: Local File System`);

    try {
        const backendCode = await generateBackendCode(idea, prd);
        
        // [핵심 Action-Oriented Logic]: 로컬 하드디스크에 백엔드 디렉토리 및 파일 직접 생성 (Write)
        const outputDir = path.join(__dirname, 'Generated_Backend');
        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir);
        }
        
        const fileName = `server_${Date.now()}.js`;
        const filePath = path.join(outputDir, fileName);
        
        fs.writeFileSync(filePath, backendCode);
        console.log(`[File Written Successfully] Saved to: ${filePath}`);

        res.json({
            message: "Backend Code generated and saved to local disk.",
            fileName: fileName,
            code: backendCode
        });
    } catch (error) {
        res.status(500).json({ error: "Backend Generation & File Write failed." });
    }
});

const PORT = process.env.PORT || 3003;
if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => {
        console.log(`[Validatix Coding Module] running on port ${PORT}`);
    });
}
module.exports = app;