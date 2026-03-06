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

async function generateUICode(idea, prd) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are "The Architect", a world-class Frontend Engineer.
Your task is to translate the [User's Idea] and [Phase 2 PRD] into actual, production-ready React (Next.js) code.

[User's Idea]
"${idea}"

[Phase 2 PRD]
"${prd}"

[Execution Requirements: CRITICAL]
1. Write a SINGLE, complete, and functional React component file (.tsx) that represents the main Dashboard UI.
2. Use Tailwind CSS for modern, sleek, B2B SaaS dark-theme styling.
3. Incorporate the Information Architecture and MVP features outlined in the PRD (e.g., Sidebar, Header, Data Cards, Main Content Area).
4. Output ONLY the raw TSX code. Do NOT wrap it in markdown blockticks (\`\`\`tsx ... \`\`\`). Do NOT add any explanations. Start immediately with "import" or "export".`;

        const result = await model.generateContent(prompt);
        let code = result.response.text();
        
        // 마크다운 잔재거 로직 (안전장치)
        if (code.startsWith('```')) {
            const lines = code.split('\n');
            lines.shift();
            if (lines[lines.length - 1].trim().startsWith('```')) lines.pop();
            code = lines.join('\n');
        }

        return code;
    } catch (error) {
        console.error("Error generating UI code:", error);
        throw error;
    }
}

app.post('/api/design', async (req, res) => {
    const { idea, prd } = req.body;

    if (!idea || !prd) {
        return res.status(400).json({ error: "Idea and PRD are required." });
    }

    console.log(`[UI Design Generation Started] Target: Local File System`);

    try {
        const uiCode = await generateUICode(idea, prd);
        
        // [핵심 Action-Oriented Logic]: 로컬 하드디스크에 디렉토리 및 파일 직접 생성 (Write)
        const outputDir = path.join(__dirname, 'Generated_UI');
        if (!fs.existsSync(outputDir)){
            fs.mkdirSync(outputDir);
        }
        
        const fileName = `Dashboard_${Date.now()}.tsx`;
        const filePath = path.join(outputDir, fileName);
        
        fs.writeFileSync(filePath, uiCode);
        console.log(`[File Written Successfully] Saved to: ${filePath}`);

        res.json({
            message: "UI Design generated and saved to local disk.",
            fileName: fileName,
            code: uiCode
        });
    } catch (error) {
        res.status(500).json({ error: "UI Generation & File Write failed." });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server is successfully running on port ${PORT}`);
});
module.exports = app;