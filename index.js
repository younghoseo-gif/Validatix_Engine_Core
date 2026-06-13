require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const archiver = require('archiver');
const path = require('path');
const { exec, execSync } = require('child_process');
const https = require('https');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const multer = require('multer');
const { parse: babelParse } = require('@babel/parser');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

if (!process.env.STRIPE_SECRET_KEY) console.error("🔥 [CRITICAL] STRIPE_SECRET_KEY 누락");
if (!process.env.ANTHROPIC_API_KEY) console.error("🔥 [CRITICAL] ANTHROPIC_API_KEY 누락");

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const app = express();
app.use(cors());
// Stripe Webhook (express.json 전에 raw body로 받아야 함)
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Webhook 서명 검증 실패:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata?.userId;
        const plan = session.metadata?.plan;
        const customerId = session.customer;
        if (userId && plan) {
            const { data } = await supabaseAdmin.from('usage_limits').select('*').eq('user_id', userId).single();
            if (data) {
                await supabaseAdmin.from('usage_limits').update({ plan, is_beta: false, stripe_customer_id: customerId }).eq('user_id', userId);
            } else {
                await supabaseAdmin.from('usage_limits').insert({ user_id: userId, monthly_count: 0, plan, is_beta: false, stripe_customer_id: customerId });
            }
            console.log(`✅ [Stripe] ${userId} → ${plan} 플랜 활성화 (customer: ${customerId})`);
        }
    }

    if (event.type === 'customer.subscription.deleted') {
        const subscription = event.data.object;
        const customerId = subscription.customer;
        if (customerId) {
            const { data } = await supabaseAdmin.from('usage_limits').select('user_id').eq('stripe_customer_id', customerId).single();
            if (data) {
                await supabaseAdmin.from('usage_limits').update({ plan: 'free' }).eq('stripe_customer_id', customerId);
                console.log(`✅ [Stripe] 구독 종료 → ${data.user_id} free 전환 (customer: ${customerId})`);
            }
        }
    }

    res.json({ received: true });
});
app.use(express.json({ limit: '10mb' }));

const MODEL_CODER = "claude-sonnet-4-6";
const MODEL_QA    = "claude-sonnet-4-6";
// 베타 사용량 캡 (is_beta=true 유저에만 적용)
const BETA_GEN_LIMIT = 30;   // 베타 Pro 생성 월 30회
const BETA_IMG_LIMIT = 10;   // 베타 Pro 이미지 월 10장

const { createClient } = require('@supabase/supabase-js');
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────────────────────
// CSS / Layout / SafePage
// ─────────────────────────────────────────────────────────────
function getBaseGlobalsCss(style = {}) {
    const primaryColor = style.primaryColor || '#FF2D20';
    const bgColor = style.bgColor || '#0f0f0f';
    const fontFamily = style.fontFamily || "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";

    return `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-sans);
  --color-ring: var(--ring);
  --color-input: var(--input);
  --color-border: var(--border);
  --color-primary: var(--primary);
  --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary);
  --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted);
  --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent);
  --color-accent-foreground: var(--accent-foreground);
  --color-card: var(--card);
  --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover);
  --color-popover-foreground: var(--popover-foreground);
  --color-destructive: var(--destructive);
  --radius-sm: calc(var(--radius) * 0.6);
  --radius-md: calc(var(--radius) * 0.8);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) * 1.4);
}

.dark {
  --background: #0f0f0f;
  --foreground: #f1f1f1;
  --card: #1a1a1a;
  --card-foreground: #f1f1f1;
  --popover: #1a1a1a;
  --popover-foreground: #f1f1f1;
  --primary: ${primaryColor};
  --primary-foreground: #ffffff;
  --secondary: #222222;
  --secondary-foreground: #f1f1f1;
  --muted: #2a2a2a;
  --muted-foreground: #888888;
  --accent: #2a2a2a;
  --accent-foreground: #f1f1f1;
  --destructive: #ef4444;
  --border: #2a2a2a;
  --input: #2a2a2a;
  --ring: ${primaryColor};
  --radius: 0.625rem;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { background-color: ${bgColor}; color: #f1f1f1; font-family: ${fontFamily}; min-height: 100vh; }

.vx-nav { position: sticky; top: 0; z-index: 50; width: 100%; background: rgba(15,15,15,0.96); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255,255,255,0.08); height: 64px; }
.vx-nav-inner { max-width: 1200px; margin: 0 auto; padding: 0 24px; height: 100%; display: flex; align-items: center; justify-content: space-between; }
.vx-nav-logo { font-size: 1.25rem; font-weight: 900; color: ${primaryColor}; text-decoration: none; letter-spacing: -0.5px; flex-shrink: 0; }
.vx-nav-links { display: flex; align-items: center; gap: 32px; list-style: none; }
.vx-nav-links a { color: #ccc; text-decoration: none; font-size: 0.9rem; font-weight: 500; transition: color 0.2s; }
.vx-nav-links a:hover { color: #fff; }

.vx-hero { width: 100%; min-height: 680px; position: relative; overflow: hidden; display: flex; align-items: center; background: linear-gradient(135deg, ${bgColor} 0%, #1a0a0a 50%, #0a0a1a 100%); }
.vx-hero-bg { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.25; z-index: 0; }
.vx-hero-content { position: relative; z-index: 1; width: 100%; max-width: 1200px; margin: 0 auto; padding: 80px 24px; }

.vx-section { width: 100%; max-width: 1200px; margin: 0 auto; padding: 72px 24px; }

.vx-grid-3 { display: grid; width: 100%; grid-template-columns: repeat(3, 1fr); gap: 24px; }
.vx-grid-2 { display: grid; width: 100%; grid-template-columns: repeat(2, 1fr); gap: 24px; }
@media (max-width: 1024px) { .vx-grid-3 { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 640px) { .vx-grid-3, .vx-grid-2 { grid-template-columns: 1fr; } .vx-title { font-size: clamp(1.8rem, 5vw, 3.5rem) !important; } .vx-subtitle { font-size: 0.95rem !important; } .vx-section { padding: 48px 16px !important; } .vx-hero-content { padding: 40px 16px !important; } .vx-nav-links { gap: 16px !important; } .vx-section-title { font-size: 1.3rem !important; } .vx-hero { min-height: 520px !important; } * { word-break: keep-all; overflow-wrap: break-word; } }

.vx-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 10px; overflow: hidden; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; cursor: pointer; width: 100%; }
.vx-card:hover { transform: translateY(-6px); border-color: ${primaryColor}; box-shadow: 0 8px 32px rgba(229,9,20,0.15); }
.vx-stat-card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 14px; padding: 32px; text-align: center; transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease; }
.vx-stat-card:hover { transform: translateY(-6px); border-color: ${primaryColor}; box-shadow: 0 8px 32px ${primaryColor}26; }
.vx-price-card { transition: transform 0.2s ease, box-shadow 0.2s ease; }
.vx-price-card:hover { transform: translateY(-6px); box-shadow: 0 8px 32px ${primaryColor}26; }
.vx-card-body { padding: 16px; }
.vx-card-title { font-size: 1rem; font-weight: 700; margin-bottom: 6px; color: #f1f1f1; }
.vx-card-desc { font-size: 0.85rem; color: #888; line-height: 1.5; }

.vx-img { width: 100%; height: 200px !important; min-height: 200px !important; overflow: hidden; display: block; background: #1a1a1a; flex-shrink: 0; position: relative; }
.vx-img img { width: 100% !important; height: 100% !important; object-fit: cover; display: block; position: absolute; top: 0; left: 0; transition: transform 0.3s ease; }
.vx-card:hover .vx-img img { transform: scale(1.05); }

.vx-btn-primary { display: inline-flex; align-items: center; gap: 8px; background: ${primaryColor} !important; color: #fff !important; padding: 12px 28px; border-radius: 6px; font-weight: 700; font-size: 0.95rem; border: none !important; cursor: pointer; text-decoration: none; transition: background 0.2s, transform 0.1s; }
.vx-btn-primary:hover { background: ${primaryColor} !important; filter: brightness(0.9); transform: translateY(-1px); }
.vx-btn-secondary { display: inline-flex; align-items: center; gap: 8px; background: transparent !important; color: #f1f1f1 !important; padding: 12px 28px; border-radius: 6px; font-weight: 700; font-size: 0.95rem; border: 2px solid rgba(255,255,255,0.3) !important; cursor: pointer; text-decoration: none; transition: border-color 0.2s, transform 0.1s; }
.vx-btn-secondary:hover { border-color: #fff !important; transform: translateY(-1px); }

.vx-title { font-size: clamp(2.5rem, 6vw, 5rem); font-weight: 900; line-height: 1.05; letter-spacing: -1px; word-break: keep-all; overflow-wrap: break-word; }
.vx-subtitle { font-size: 1.1rem; color: #999; margin-top: 16px; line-height: 1.7; max-width: 600px; }
.vx-section-title { font-size: 1.6rem; font-weight: 800; margin-bottom: 32px; display: flex; align-items: center; gap: 12px; }
.vx-label { font-size: 0.75rem; font-weight: 700; letter-spacing: 2px; text-transform: uppercase; color: ${primaryColor}; margin-bottom: 16px; display: block; }

.vx-footer { background: #0a0a0a; border-top: 1px solid #1a1a1a; padding: 48px 24px; text-align: center; color: #555; font-size: 0.875rem; }
.vx-footer a { color: #777; text-decoration: none; margin: 0 12px; }
.vx-footer a:hover { color: #ccc; }
.vx-divider { border: none; border-top: 1px solid #1e1e1e; margin: 0; }
`;
}

function getBaseLayout(json = {}) {
    const title = json?.navbar?.logo || 'Validatix App';
    const description = json?.hero?.subtitle?.ko || json?.hero?.subtitle?.en || 'Generated by Validatix Engine';
    const ogImage = 'https://picsum.photos/seed/og/1200/630';

    return `import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "${title}",
  description: "${description}",
  openGraph: {
    title: "${title}",
    description: "${description}",
    images: ["${ogImage}"],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "${title}",
    description: "${description}",
    images: ["${ogImage}"],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="index, follow" />
      </head>
      <body style={{ backgroundColor: '#0f0f0f', color: '#f1f1f1', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  );
}
`;
}

function generateSafePage(componentPaths, contentJson = null) {
    const validComponents = componentPaths
        .filter(p => p !== 'app/page.tsx' && !p.endsWith('types.ts') && p.endsWith('.tsx'));

    // 비주얼 에디터의 SectionKey → 컴포넌트 이름 매핑
    const SECTION_KEY_TO_COMPONENT = {
        navbar: 'Navbar',
        hero: 'HeroSection',
        features: 'FeatureSection',
        stats: 'StatsSection',
        pricing: 'PricingSection',
        faq: 'FAQSection',
        cta: 'CTASection',
        footer: 'Footer'
    };

    // 기본 섹션 순서 (contentJson에 sectionOrder가 없을 때 사용)
    const DEFAULT_ORDER = [
        'Navbar',
        'HeroSection',
        'FeatureSection',
        'StatsSection',
        'CTASection',
        'PricingSection',
        'FAQSection',
        'Footer',
        'Watermark'
    ];

    // 사용자가 비주얼 에디터에서 변경한 순서를 컴포넌트 이름 배열로 변환
    let sectionOrder = DEFAULT_ORDER;
    if (contentJson && Array.isArray(contentJson.sectionOrder) && contentJson.sectionOrder.length > 0) {
        const userOrder = contentJson.sectionOrder
            .map(key => SECTION_KEY_TO_COMPONENT[key])
            .filter(name => !!name); // 매핑 안 된 키는 무시
        // Watermark는 항상 마지막에 유지
        sectionOrder = [...userOrder, 'Watermark'];
    }

    // 사용자가 숨긴 섹션을 컴포넌트 이름 Set으로 변환
    const hiddenComponents = new Set();
    if (contentJson && Array.isArray(contentJson.hiddenSections)) {
        contentJson.hiddenSections.forEach(key => {
            const compName = SECTION_KEY_TO_COMPONENT[key];
            if (compName) hiddenComponents.add(compName);
        });
    }

    // 1) 사용자 순서로 정렬
    const sorted = [...validComponents].sort((a, b) => {
        const nameA = path.basename(a, '.tsx');
        const nameB = path.basename(b, '.tsx');
        const idxA = sectionOrder.indexOf(nameA);
        const idxB = sectionOrder.indexOf(nameB);
        const orderA = idxA === -1 ? 999 : idxA;
        const orderB = idxB === -1 ? 999 : idxB;
        return orderA - orderB;
    });

    // 2) 숨긴 섹션 제외 (Navbar, Footer, Watermark는 보호)
    const PROTECTED = new Set(['Navbar', 'Footer', 'Watermark']);
    const visible = sorted.filter(p => {
        const name = path.basename(p, '.tsx');
        if (PROTECTED.has(name)) return true;
        return !hiddenComponents.has(name);
    });

    const imports = visible.map(p => {
        const name = path.basename(p, '.tsx');
        return `const ${name} = dynamic(() => import('../components/${name}'), { ssr: false });`;
    }).join('\n');

    const jsx = visible.map(p => `      <${path.basename(p, '.tsx')} />`).join('\n');

    return `"use client";
import dynamic from 'next/dynamic';

${imports}

export default function Page() {
  return (
    <main style={{ backgroundColor: '#0f0f0f', minHeight: '100vh' }}>
${jsx}
    </main>
  );
}
`;
}

// ─────────────────────────────────────────────────────────────
// 1. 제목 생성
// ─────────────────────────────────────────────────────────────
app.post('/api/title', async (req, res) => {
    try {
        const { message } = req.body;
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 100,
            messages: [{ role: "user", content: `핵심 단어 추출기. 다음 문장을 3~4어절 명사형으로 요약. 마크다운/설명 금지.\nUser: ${message}` }]
        });
        res.json({ title: result.content[0].text.trim() });
    } catch (error) { res.status(500).json({ title: "새 프로젝트" }); }
});

// ─────────────────────────────────────────────────────────────
// 사용량 체크 API
// ─────────────────────────────────────────────────────────────
app.get('/api/usage/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        const { data, error } = await supabaseAdmin
            .from('usage_limits')
            .select('*')
            .eq('user_id', userId)
            .single();
        if (error || !data) return res.json({ count: 0, plan: 'free', canGenerate: true, isPaid: false });
        const resetAt = new Date(data.reset_at);
        const now = new Date();
        const isPaid = !data.is_beta && data.plan !== 'free';
        if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
            await supabaseAdmin.from('usage_limits').update({ monthly_count: 0, reset_at: now.toISOString() }).eq('user_id', userId);
            return res.json({ count: 0, plan: data.plan, canGenerate: true, isPaid });
        }
        const limit = data.is_beta ? BETA_GEN_LIMIT : (data.plan === 'free' ? 3 : data.plan === 'starter' ? 20 : 999999);
        res.json({ count: data.monthly_count, plan: data.plan, canGenerate: data.monthly_count < limit, isPaid });
    } catch (error) { res.status(500).json({ error: '사용량 확인 실패' }); }
});

app.post('/api/usage/:userId/increment', async (req, res) => {
    const { userId } = req.params;
    try {
        const { data } = await supabaseAdmin.from('usage_limits').select('*').eq('user_id', userId).single();
        if (!data) {
            await supabaseAdmin.from('usage_limits').insert({ user_id: userId, monthly_count: 1, plan: 'free' });
        } else {
            await supabaseAdmin.from('usage_limits').update({ monthly_count: data.monthly_count + 1 }).eq('user_id', userId);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: '사용량 업데이트 실패' }); }
});

// ─────────────────────────────────────────────────────────────
// 2. AI 기획 에이전트
// ─────────────────────────────────────────────────────────────
app.post('/api/agent', async (req, res) => {
    try {
        const { message, history, image, lang } = req.body;
const isKo = lang === 'ko';
        const messages = [];
        if (history?.length > 0) {
            history.forEach(msg => {
                if (msg.role === 'user') messages.push({ role: 'user', content: msg.text });
                else if (msg.role === 'agent') messages.push({ role: 'assistant', content: msg.text });
            });
        }
        if (image) {
            messages.push({
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
                    { type: 'text', text: message }
                ]
            });
        } else {
            messages.push({ role: 'user', content: message });
        }
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 4096,
            system: `당신은 Validatix의 AI 기획자이자 비즈니스 데이터 전문가입니다. 사용자의 아이디어를 듣고 핵심을 파악해서 최적의 솔루션을 설계하는 게 역할입니다. 사용자가 파일(PDF, 문서, 코드 등)이나 이미지를 첨부하면 해당 내용을 분석하고 아이디어 구체화에 활용하세요. 파일 요약, 내용 분석, 기존 기획서 기반 확장 등 모든 파일 관련 요청에 적극적으로 응답하세요.

당신의 두 가지 역할입니다.

1. 기획 역할: 사용자 아이디어를 역질문으로 구체화해서 PRD를 완성합니다.
2. 데이터 역할: 사용자가 막히거나 데이터가 필요할 때 즉시 답변하고, 답변 후 방금 말한 내용이 이 서비스에도 해당하는지 사용자 의견을 먼저 확인한 뒤 기획 질문으로 연결합니다.

데이터 역할로 즉시 답변해야 하는 주제들입니다.
- 경쟁사 운영 방식, 수익화 구조, 시장 점유율
- 시장 규모, 트렌드, 성장 가능성
- 가격 책정 방향 (구독제/단건/광고 등)
- 타겟 고객 분석 (연령, 직업, 행동 패턴)
- 기능 우선순위 (MVP 핵심 기능)
- 수익화 모델 추천
- 유사 서비스 사례

데이터 답변 형식입니다.
사용자가 위 주제를 물어보면 즉시 데이터로 답변하세요. 답변 후에는 반드시 방금 말한 내용이 이 서비스에도 해당하는지 사용자 의견을 먼저 확인하세요. 확인이 된 후에 다음 기획 질문으로 넘어가세요.
예시: "카카오파킹과 아이파킹의 핵심 고객은 주차장 사업자입니다. 운전자는 무료로 쓰고, 사업자가 플랫폼 수수료를 내는 구조입니다. 이 서비스도 비슷한 방향으로 가실 건가요, 아니면 다른 방향을 생각하고 계신가요?"

절대 하지 말아야 할 것들입니다.
- 기술 스택, 개발 방법, 외주 여부, 직접 개발 여부를 절대 묻지 마세요. Validatix가 모든 개발과 배포를 자동으로 처리합니다.
- 사용자 답변에 동조하거나 확정 짓는 모든 표현을 금지합니다. 아래는 금지 표현의 예시이며, 이와 유사한 뉘앙스의 모든 표현이 금지됩니다.
  금지: "좋은 선택이군요!", "좋은 접근이에요", "그 방향이 자연스럽네요", "그거죠", "리스크가 작으니까요", "맞아요", "좋네요", "훌륭해요", "완벽해요", "정확해요", "그렇죠", "맞습니다", "동의합니다", "좋은 생각이에요", "센스 있으시네요", "확실히 그렇죠", "오 좋은데요", "딱 좋은 방향이에요", "바로 그거예요", "네 맞아요", "좋은 판단이에요", "현명한 선택이에요", "명확하네요", "맞는 말씀이에요", "정확하게 짚으셨어요", "핵심을 잘 짚으셨어요", "포인트를 잘 잡으셨어요", "확실하네요", "분명하네요", "날카로우시네요", "예리하시네요", "잘 아시네요"
  핵심 원칙: 사용자가 무엇을 답하든 칭찬, 감탄, 동의, 확인, 격려를 하지 마세요. 사용자 답변을 받으면 곧바로 다음 질문으로 넘어가세요. 사용자의 답변이 틀렸거나 위험한 방향이면 그 이유를 설명하고 대안을 제시하세요.
  절대 금지 패턴: 사용자의 답변 내용을 요약, 확인, 재진술, 평가하는 모든 문장을 금지합니다. 사용자가 "X"라고 답했을 때 "X가 핵심이네요", "X 방향이 명확하네요", "X까지 잡으셨네요", "X가 포인트군요", "X 구조가 확정됐네요", "That's a solid X", "That's a clear X", "So the core value is X" 같은 형태로 답변을 되풀이하는 것을 절대 하지 마세요. 사용자 답변을 언급하지 말고 곧바로 다음 질문이나 데이터를 제시하세요.
- "하나 더 여쭤볼게요.", "한 가지 궁금한 게 있어요", "한 가지 더 여쭤볼게요", "솔직히 말씀드리면" 같은 예고 문구나 불필요한 서두를 쓰지 마세요. 바로 질문하세요.
- 사용자가 모르겠다고 하면 혼자 결정하거나 확정 짓지 마세요. 이 분야에서 일반적으로 많이 쓰이는 방향 2~3가지를 제시하고 사용자가 선택하게 하세요.
- 이전 질문에 답변이 없는데 다음 질문으로 넘어가지 마세요. 이전 질문에 먼저 답변을 받으세요.
- 기능 추가, 확장, 개선을 언급할 때는 "Validatix에서 언제든 재생성하면 됩니다"라는 점을 자연스럽게 포함하세요. "나중에 추가하면 된다"처럼 방법을 모호하게 남기지 마세요.

역질문 깊이 가이드입니다.

표면적 질문을 하지 마세요. 아래 단계를 따르세요.

1단계 (핵심 문제): 이 서비스가 해결하려는 진짜 문제가 뭔지 파악합니다.
- 나쁜 질문: "타겟 유저가 누구인가요?"
- 좋은 질문: "이 문제를 지금 겪고 있는 사람들이 현재 어떻게 해결하고 있나요? 기존 방법에서 가장 불편한 점이 뭔가요?"

2단계 (돈의 흐름): 누가 돈을 내는지, 왜 내는지를 파악합니다.
- 나쁜 질문: "수익 모델은 뭘로 할까요?"
- 좋은 질문: "이 서비스 없이 같은 문제를 해결하려면 지금 얼마를 쓰고 있나요? 그 비용보다 싸면 전환할 의향이 있을까요?"

3단계 (경쟁 우위): 왜 이 서비스여야 하는지를 파악합니다.
- 나쁜 질문: "경쟁사와 차별점이 뭔가요?"
- 좋은 질문: "기존 서비스들이 이 문제를 못 풀고 있는 이유가 뭐라고 보세요? 기술적 한계인지, 비즈니스 모델 문제인지, 아니면 아예 시도를 안 한 건지요?"

4단계 (실행 가능성): 최소 기능으로 검증 가능한 범위를 확정합니다.
- 나쁜 질문: "어떤 기능이 필요하세요?"
- 좋은 질문: "사용자가 이 앱을 처음 열었을 때 '이거다' 하고 느끼려면 딱 한 가지 기능만 완벽하게 되면 되는데, 그게 뭘까요?"

이 4단계를 순서대로 진행하되, 사용자가 이미 답한 단계는 건너뛰세요. 각 단계에서 1~2개 질문이면 충분합니다. 총 역질문은 5~8개 사이로 유지하세요.

대화 규칙입니다.

마크다운 문법을 절대 쓰지 마세요. **, ##, ---, - 같은 기호 금지입니다. 숫자는 반드시 1, 2, 3 같은 아라비아 숫자를 쓰세요. 목록은 "• "로 시작하세요.

말투는 친한 지인과 카카오톡으로 대화하는 것처럼 자연스럽게 하세요. 아래 규칙을 반드시 지키세요.
- 매 답변을 칭찬이나 감탄으로 시작하지 마세요. 첫 문장부터 바로 본론(질문 또는 데이터)으로 시작하세요.
- "하나 더 여쭤볼게요." 같은 예고 문구를 쓰지 마세요. 바로 질문하세요.
- 문장과 문장 사이에 불필요한 빈 줄을 넣지 마세요.
- 이모지는 대화 전체에서 1~2개만 쓰세요.
- 질문은 한 번에 하나만 하세요. 절대로 한 답변에 질문을 2개 이상 넣지 마세요. 질문이 2개 필요하면 첫 번째 질문만 하고 답변을 기다리세요.
- 맞춤법을 정확히 지키세요. "예요/에요" 구분: 받침 있으면 "이에요", 받침 없으면 "예요". "되"와 "돼" 구분: "하여"로 바꿔서 자연스러우면 "되", "해"로 바꿔서 자연스러우면 "돼".
- 반드시 존댓말을 사용하세요. 반말은 절대 쓰지 마세요.
- 존댓말 사용 여부를 언급하거나 설명하지 마세요. 그냥 존댓말로만 답변하세요.

처음에는 아이디어를 듣고 핵심을 파악하세요. 그 다음 역질문 깊이 가이드의 4단계를 따라 질문을 하나씩 하세요. 역질문이 충분하다고 판단되면 반드시 아래 형식으로 최종 기획안을 출력하세요.

[FINAL_IDEA]한 줄 아이디어 요약[/FINAL_IDEA]

[FINAL_PRD]
제품 개요
해결하는 핵심 문제
핵심 기능 3~5가지
UI/UX 구조
타겟 사용자
경쟁사 대비 차별점
[/FINAL_PRD]

Detect the language of the user's FIRST message. If the first message is in English, respond in English for the entire conversation. If the first message is in Korean, respond in Korean for the entire conversation. Do NOT mix languages.`,
            messages
        });
        res.json({ reply: result.content[0].text });
    } catch (error) { 
    console.error('Agent error:', error.message);
    res.status(500).json({ reply: "죄송합니다. 일시적인 오류가 발생했습니다. 다시 시도해 주세요." }); 
}
});

// ─────────────────────────────────────────────────────────────
// 3. 히스토리 삭제
// ─────────────────────────────────────────────────────────────
app.delete('/api/clear-history', async (req, res) => {
    try {
        const generatedDir = path.join(__dirname, 'Generated_Projects');
        if (fs.existsSync(generatedDir)) {
            fs.rmSync(generatedDir, { recursive: true, force: true });
            fs.mkdirSync(generatedDir);
        }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: '삭제 실패' }); }
});

// ─────────────────────────────────────────────────────────────
// 4. 프롬프트 증폭
// ─────────────────────────────────────────────────────────────
async function expandPrompt(userIdea, prd, marketData, competitorData) {
    try {
        const marketContext = marketData ? `
시장조사 결과:
- 시장규모: TAM ${marketData.tam} / SAM ${marketData.sam} / SOM ${marketData.som}
- 핵심 타겟: ${marketData.target}
- 주요 트렌드: ${marketData.trends.join(', ')}
- 수익화 가능성: ${marketData.score}/10
- 경쟁 강도: ${marketData.competition}
- 추천 수익 모델: ${marketData.revenueModel}
- 추천 시작 가격: ${marketData.startPrice}
- 글로벌 가능성: ${marketData.global}
- 예상 첫 달 유료 유저: ${marketData.firstMonthUsers}
` : '';
        const competitorContext = competitorData ? `
경쟁사분석 결과:
- 경쟁 환경: ${competitorData.summary}
- 주요 경쟁사: ${competitorData.competitors.map(c => c.name).join(', ')}
- 차별화 포인트: ${competitorData.differentiation.join(', ')}
- 시장 기회: ${competitorData.opportunity}
` : '';

        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 1024,
            messages: [{ role: "user", content: `당신은 수석 UX 기획자입니다. 아래 아이디어와 PRD, 시장조사 결과를 바탕으로 개발자가 이해할 수 있는 상세한 UI/UX 프롬프트로 증폭시키세요. 설명 없이 프롬프트만 출력하세요.\n아이디어: "${userIdea}"\nPRD: "${prd}"${marketContext}${competitorContext}` }]
        });
        return result.content[0].text.trim();
    } catch (error) { return `${userIdea}\n\n${prd}`; }
}

// ─────────────────────────────────────────────────────────────
// 4-0. 경쟁사분석 자동화 (5주차)
// ─────────────────────────────────────────────────────────────
async function generateCompetitorAnalysis(idea, prd, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Claude] 🔍 경쟁사 자동 분석 중...` : `[Claude] 🔍 Analyzing competitors...`);
    const result = await anthropic.messages.create({
        model: MODEL_CODER,
        max_tokens: 4096,
        messages: [{ role: "user", content: `You are a competitive intelligence analyst. Analyze this app idea and identify real competitors.

App idea: "${idea}"
PRD: "${prd}"

Output ONLY a valid JSON object. No markdown, no explanation.

{
  "summary": "${isKo ? '한 줄 경쟁 환경 요약 (Korean, max 40 chars)' : 'One-line competitive landscape summary (English, max 60 chars)'}",
  "competitors": [
    {
      "name": "Competitor name",
      "url": "competitor website URL (best guess)",
      "description": "${isKo ? 'Korean' : 'English'}: 2줄 설명 (what they do, who they target)",
      "strengths": ["${isKo ? 'Korean' : 'English'} strength 1", "${isKo ? 'Korean' : 'English'} strength 2"],
      "weaknesses": ["${isKo ? 'Korean' : 'English'} weakness 1", "${isKo ? 'Korean' : 'English'} weakness 2"],
      "pricing": "${isKo ? 'Korean' : 'English'} pricing description",
      "threat": "high|medium|low"
    }
  ],
  "differentiation": ["${isKo ? 'Korean' : 'English'} differentiator 1", "${isKo ? 'Korean' : 'English'} differentiator 2", "${isKo ? 'Korean' : 'English'} differentiator 3"],
  "opportunity": "${isKo ? 'Korean' : 'English'}: 2-3 sentences on the gap in the market this idea can exploit",
  "strategy": {
    "positioning": "${isKo ? 'Korean' : 'English'}: 1-2 sentences on how to position against competitors",
    "pricing_strategy": "${isKo ? 'Korean' : 'English'}: recommended pricing relative to competitors",
    "quick_wins": ["${isKo ? 'Korean' : 'English'}: immediate action 1 to gain edge", "${isKo ? 'Korean' : 'English'}: immediate action 2", "${isKo ? 'Korean' : 'English'}: immediate action 3"]
  },
  "marketGaps": ["${isKo ? 'Korean' : 'English'}: gap 1 that no competitor addresses", "${isKo ? 'Korean' : 'English'}: gap 2", "${isKo ? 'Korean' : 'English'}: gap 3"]
}

RULES:
- competitors: 3-5 real, specific competitors (not generic)
- url: actual or best-guess website URL
- strengths: exactly 2 items each
- weaknesses: exactly 2 items each
- differentiation: exactly 3 items
- strategy: REQUIRED. positioning + pricing_strategy + exactly 3 quick_wins
- marketGaps: REQUIRED. exactly 3 gaps no competitor currently fills
- All text in ${isKo ? 'Korean' : 'English'} except competitor names and URLs
- threat: must be one of high/medium/low
- Output ONLY the JSON` }]
    });

    const fullText = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

    const raw = fullText.trim()
        .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

    try {
        const competitor = JSON.parse(raw);
        sendLog(isKo ? `[Claude] ✅ 경쟁사분석 완료: ${competitor.competitors.length}개 경쟁사 탐색` : `[Claude] ✅ Competitor analysis done: ${competitor.competitors.length} competitors found`);
        return competitor;
    } catch(e) {
        sendLog(`⚠️ 경쟁사분석 파싱 실패.`);
        return null;
    }
}
// ─────────────────────────────────────────────────────────────
// 4-1. 시장조사 자동화 (4주차)
// ─────────────────────────────────────────────────────────────
async function generateMarketResearch(idea, prd, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Claude] 📊 시장조사 자동 분석 중...` : `[Claude] 📊 Running market research...`);
    const result = await anthropic.messages.create({
        model: MODEL_CODER,
        max_tokens: 4096,
        messages: [{ role: "user", content: `You are a market research analyst. Analyze this app idea and PRD, then provide a comprehensive market research report.

App idea: "${idea}"
PRD: "${prd}"

Output ONLY a valid JSON object. No markdown, no explanation.

{
  "tam": "Total Addressable Market in USD (e.g. $50B)",
  "sam": "Serviceable Addressable Market in USD (e.g. $5B)",
  "som": "Serviceable Obtainable Market in USD (e.g. $500M)",
  "target": "Core target customer description in ${isKo ? 'Korean' : 'English'} (1-2 sentences)",
  "trends": ["${isKo ? 'Korean' : 'English'} trend 1", "${isKo ? 'Korean' : 'English'} trend 2", "${isKo ? 'Korean' : 'English'} trend 3"],
  "score": 8.2,
  "scoreAdvice": "2-3 sentences of specific actionable ${isKo ? 'Korean' : 'English'} strategy advice for THIS idea based on the score",
  "competition": "${isKo ? 'Korean' : 'English'} description of competition level and key competitors",
  "revenueModel": "${isKo ? 'Korean' : 'English'} recommended revenue model",
  "startPrice": "${isKo ? 'Korean' : 'English'} recommended starting price. MUST be a single number with currency symbol, e.g. '$9/mo' or '₩9,900/월'. No ranges, no text, just one price.",
  "global": "${isKo ? 'Korean' : 'English'} assessment of global expansion potential",
  "firstMonthUsers": "${isKo ? 'Korean' : 'English'} estimate of first month paid users",
  "conclusion": "${isKo ? 'Korean' : 'English'} 3-4 sentence executive summary: Is this idea worth pursuing? What is the single biggest opportunity and the single biggest risk?",
  "actionPlan": ["${isKo ? 'Korean' : 'English'} action step 1", "${isKo ? 'Korean' : 'English'} action step 2", "${isKo ? 'Korean' : 'English'} action step 3"],
  "revenueSimulation": {
    "month1": { "users": 50, "revenue": "$X", "costs": "$Y", "profit": "$Z" },
    "month6": { "users": 200, "revenue": "$X", "costs": "$Y", "profit": "$Z" },
    "month12": { "users": 500, "revenue": "$X", "costs": "$Y", "profit": "$Z" }
  }
}

RULES:
- score: number between 1-10 (one decimal). Be STRICT and realistic. Strong ideas: 8-9. Average: 5-7. Weak: 2-4. Most ideas should score 4-7.
- scoreAdvice: REQUIRED. 2-3 sentences in ${isKo ? 'Korean' : 'English'}. Concrete actionable strategy.
- tam: must be realistic and specific to this exact idea's addressable market
- trends: exactly 3 items in ${isKo ? 'Korean' : 'English'}
- conclusion: REQUIRED. 3-4 sentences in ${isKo ? 'Korean' : 'English'}. Clear verdict on viability.
- actionPlan: REQUIRED. exactly 3 concrete action steps in ${isKo ? 'Korean' : 'English'}.
- revenueSimulation: REQUIRED. Realistic projections based on startPrice and market size. costs should include server, API, marketing estimates.
- revenueSimulation profit: revenue minus costs. Can be negative for month1.
- All text fields in ${isKo ? 'Korean' : 'English'} except tam/sam/som and revenueSimulation dollar amounts
- firstMonthUsers: be realistic. Product Hunt launch typically yields 50-150 paid users.
- Output ONLY the JSON` }]
    });

    const raw = result.content[0].text.trim()
        .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

    try {
        const market = JSON.parse(raw);
        sendLog(isKo ? `[Claude] ✅ 시장조사 완료: 수익화 가능성 ${market.score}/10` : `[Claude] ✅ Market research done: Score ${market.score}/10`);
        return market;
    } catch(e) {
        sendLog(`⚠️ 시장조사 파싱 실패. 재시도 중...`);
        try {
            const retryResult = await anthropic.messages.create({
                model: MODEL_CODER,
                max_tokens: 4096,
                messages: [{ role: "user", content: raw + "\n\nReturn ONLY valid JSON, no markdown." }]
            });
            const retryRaw = retryResult.content[0].text.trim()
                .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
            const market = JSON.parse(retryRaw);
            sendLog(`[Claude] ✅ 시장조사 재시도 성공: 수익화 가능성 ${market.score}/10`);
            return market;
        } catch(e2) {
            sendLog(`⚠️ 시장조사 재시도 실패. 기본값 사용.`);
            return null;
        }
    }
}

// ─────────────────────────────────────────────────────────────
// 5. DB 스키마 자동 설계
// ─────────────────────────────────────────────────────────────
async function generateDBSchema(idea, prd, sendLog, lang = 'ko') {
    // 컬럼 타입 안전 변환 (모르는 값은 무조건 text로 처리해서 안 깨지게)
    function toPgType(t) {
        const map = {
            text: 'text', string: 'text',
            integer: 'integer', int: 'integer',
            numeric: 'numeric', number: 'numeric', decimal: 'numeric', float: 'numeric',
            boolean: 'boolean', bool: 'boolean',
            date: 'date',
            timestamptz: 'timestamptz', timestamp: 'timestamptz'
        };
        return map[String(t || 'text').toLowerCase()] || 'text';
    }

    const isKo = lang === 'ko';
    sendLog(isKo ? `[Claude] 🗄️ DB 스키마 설계 중...` : `[Claude] 🗄️ Designing DB schema...`);
    const result = await anthropic.messages.create({
        model: MODEL_CODER,
        max_tokens: 2000,
        messages: [{ role: "user", content: `You are a database architect. Based on this app idea and PRD, design the minimal database schema needed.

App idea: "${idea}"
PRD: "${prd}"

Output ONLY a valid JSON object. No markdown, no explanation.

{
  "tableName": "main table name (snake_case, plural)",
  "displayName": "Korean display name",
  "columns": [
    { "name": "id", "type": "uuid", "default": "gen_random_uuid()", "primaryKey": true },
    { "name": "user_id", "type": "uuid", "references": "auth.users(id)", "onDelete": "CASCADE" },
    { "name": "created_at", "type": "timestamptz", "default": "now()" },
    { "name": "field1", "type": "text", "label": "Korean label", "placeholder": "Korean placeholder", "required": true },
    { "name": "quantity", "type": "numeric", "label": "수량", "placeholder": "0", "required": true }
  ],
  "primaryField": "field1 name",
  "listFields": ["field1", "field2"],
  "uniqueTogether": [],
  "nonNegative": [],
  "stockPairs": []
}

RULES:
- 3-5 meaningful fields only (exclude id, user_id, created_at)
- tableName must be snake_case plural
- All labels and placeholders in Korean
- "type" for each user field must be one of: text, integer, numeric, boolean, date, timestamptz. Choose the RIGHT type — use "numeric" for quantities/amounts/prices/stock, "integer" for counts, "date" for calendar dates, "boolean" for yes/no. Do NOT default every field to text.
- field "required": true fields must NOT be nullable
- "uniqueTogether": if this app must prevent duplicate records (e.g. a booking app must not allow the same room on the same date; a scheduling app must not double-book a slot), list the column-name combination(s) that must be unique together, e.g. [["room_number","check_in_date"]]. If not needed, use [].
- "nonNegative": list numeric/integer column names that must never drop below zero (e.g. stock quantity, balance). If none, use [].
- STOCK/THRESHOLD PAIR: If this app's core purpose involves tracking quantities/stock/inventory/remaining capacity (e.g. cafe ingredient stock, warehouse inventory, room/seat remaining capacity), you MUST create BOTH a current-value numeric column (e.g. "stock", "quantity", "remaining") AND a matching minimum-threshold numeric column (e.g. "min_stock", "reorder_point", "min_quantity"). Both must use type "integer" or "numeric". This is what enables a real low-stock alert.
- "stockPairs": for EACH current/threshold pair you created above, add an object { "currentField": "stock", "thresholdField": "min_stock", "label": "재고 부족" }. label must be short Korean. If this app does NOT track stock/quantity thresholds, use [].
- Output ONLY the JSON` }]
    });

    const raw = result.content[0].text.trim()
        .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
    const schema = JSON.parse(raw);

    const userCols = schema.columns.filter(c => !['id','user_id','created_at'].includes(c.name));

    // (변경) text 고정 대신, 컬럼별 타입을 안전하게 적용
    const colDefs = userCols.map(c => {
        const notNull = c.required ? ' NOT NULL' : '';
        return `${c.name} ${toPgType(c.type)}${notNull}`;
    }).join(', ');

    // (추가) 제약 조립 — Claude는 "어떤 컬럼"인지만 정하고, SQL은 코드가 안전하게 생성
    const validCols = new Set(['id','user_id','created_at', ...userCols.map(c => c.name)]);
    const numericCols = new Set(
        userCols.filter(c => ['integer','numeric'].includes(toPgType(c.type))).map(c => c.name)
    );

    // 재고쌍을 먼저 검증 (현재값·최소값 컬럼에 음수 차단 CHECK를 자동 포함시키기 위해 위로 이동)
    schema.stockPairs = Array.isArray(schema.stockPairs)
        ? schema.stockPairs.filter(p =>
            p && typeof p === 'object'
            && numericCols.has(p.currentField)
            && numericCols.has(p.thresholdField)
            && p.currentField !== p.thresholdField)
        : [];

    const constraintDefs = [];
    // 중복 금지(예: 같은 객실+같은 날짜) — 컬럼이 모두 실제 존재할 때만
    if (Array.isArray(schema.uniqueTogether)) {
        schema.uniqueTogether.forEach(group => {
            if (Array.isArray(group) && group.length > 0 && group.every(col => validCols.has(col))) {
                constraintDefs.push(`UNIQUE(${group.join(', ')})`);
            }
        });
    }
    // 음수 금지: Claude가 지정한 nonNegative + 재고쌍의 현재값/최소값 컬럼(재고는 음수 불가가 자명)
    const nonNegSet = new Set();
    if (Array.isArray(schema.nonNegative)) {
        schema.nonNegative.forEach(col => { if (numericCols.has(col)) nonNegSet.add(col); });
    }
    schema.stockPairs.forEach(p => {
        if (numericCols.has(p.currentField)) nonNegSet.add(p.currentField);
        if (numericCols.has(p.thresholdField)) nonNegSet.add(p.thresholdField);
    });
    nonNegSet.forEach(col => constraintDefs.push(`CHECK (${col} >= 0)`));

    const constraintSql = constraintDefs.length > 0 ? ', ' + constraintDefs.join(', ') : '';

    // (변경) sqlCreate에 제약(constraintSql)을 삽입
    schema.sqlCreate = `DROP TABLE IF EXISTS ${schema.tableName} CASCADE; CREATE TABLE ${schema.tableName} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, created_at timestamptz DEFAULT now(), ${colDefs}${constraintSql}); ALTER TABLE ${schema.tableName} ENABLE ROW LEVEL SECURITY; DROP POLICY IF EXISTS ${schema.tableName}_user_policy ON ${schema.tableName}; CREATE POLICY ${schema.tableName}_user_policy ON ${schema.tableName} FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;

    sendLog(isKo ? `[Claude] ✅ DB 스키마 완료: ${schema.tableName} (${userCols.map(c=>c.name).join(', ')})${constraintDefs.length ? ` | 제약 ${constraintDefs.length}개` : ''}${schema.stockPairs.length ? ` | 재고쌍 ${schema.stockPairs.length}개` : ''}` : `[Claude] ✅ DB schema ready: ${schema.tableName} (${userCols.map(c=>c.name).join(', ')})`);
    return schema;
}

// ─────────────────────────────────────────────────────────────
// 5-1. 아이디어별 핵심 기능 스펙 자동 추출
// ─────────────────────────────────────────────────────────────
async function generateFeatureSpec(idea, prd, schema, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Claude] 🧠 핵심 기능 스펙 분석 중...` : `[Claude] 🧠 Analyzing feature specs...`);
    const userColNames = schema.columns
        .filter(c => !['id','user_id','created_at'].includes(c.name))
        .map(c => c.name);

    // (추가) 검증된 stockPairs로 비교 위젯을 코드가 직접 조립 (Claude에 안 맡김 = 안전)
    const numericTypeSet = new Set(['integer','numeric','int','number','decimal','float']);
    const isNumericCol = (colName) => {
        const col = schema.columns.find(c => c.name === colName);
        return !!(col && numericTypeSet.has(String(col.type || '').toLowerCase()));
    };
    const pickNameField = (currentField) => {
        if (schema.primaryField && !isNumericCol(schema.primaryField)) return schema.primaryField;
        if (Array.isArray(schema.listFields)) {
            const nonNum = schema.listFields.find(f => !isNumericCol(f) && f !== currentField);
            if (nonNum) return nonNum;
        }
        const userCol = schema.columns.find(c => !['id','user_id','created_at'].includes(c.name) && !isNumericCol(c.name) && c.name !== currentField);
        if (userCol) return userCol.name;
        return currentField;
    };
    const addComparisonWidgets = (baseWidgets) => {
        if (!Array.isArray(schema.stockPairs) || schema.stockPairs.length === 0) {
            return baseWidgets || [];
        }
        const comp = schema.stockPairs.map(p => ({
            type: 'comparison',
            title: p.label || '부족 임박',
            currentField: p.currentField,
            thresholdField: p.thresholdField,
            nameField: pickNameField(p.currentField),
            label: p.label || '부족 임박 항목'
        }));
        return [...comp, ...(baseWidgets || [])];
    };

    const result = await anthropic.messages.create({
        model: MODEL_CODER,
        max_tokens: 2000,
        messages: [{ role: "user", content: `You are a product analyst. Analyze this app idea and PRD, then design 2 "feature widgets" to show at the top of the dashboard.

App idea: "${idea}"
PRD: "${prd}"
DB table: "${schema.tableName}"
DB fields (use EXACTLY these names): ${JSON.stringify(userColNames)}

Output ONLY valid JSON. No markdown, no explanation.

{
  "appType": "one of: reading|booking|todo|fitness|finance|social|inventory|learning|other",
  "widgets": [
    {
      "type": "stat_cards",
      "title": "Korean title",
      "cards": [
        { "label": "Korean label", "field": "total", "color": "#FF2D20", "icon": "List" },
        { "label": "Korean label", "field": "recent", "color": "#3b82f6", "icon": "Clock" }
      ]
    },
    {
      "type": "chart",
      "title": "Korean title",
      "chartType": "bar",
      "dataField": "created_at",
      "label": "Korean label"
    }
  ]
}

RULES:
- widgets: exactly 2 items
- stat_cards cards: 2-3 items
- field must be "total", "recent", or one of: ${JSON.stringify(userColNames)}
- icon must be one of: BookOpen, Calendar, CheckSquare, TrendingUp, Star, Clock, BarChart2, Activity, Target, Award, Bookmark, List
- ALL text in Korean
- Output ONLY JSON` }]
    });

    try {
        const raw = result.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
        const spec = JSON.parse(raw);
        spec.widgets = addComparisonWidgets(spec.widgets);
        sendLog(isKo ? `[Claude] ✅ 기능 스펙 완료: ${spec.appType} (위젯 ${spec.widgets.length}개)` : `[Claude] ✅ Feature spec ready: ${spec.appType} (${spec.widgets.length} widgets)`);
        return spec;
    } catch(e) {
        sendLog(`⚠️ 기능 스펙 파싱 실패. 기본 위젯 사용.`);
        return {
            appType: 'other',
            widgets: addComparisonWidgets([
                { type: 'stat_cards', title: '전체 현황', cards: [
                    { label: '전체 항목', field: 'total', color: '#FF2D20', icon: 'List' },
                    { label: '이번 주 추가', field: 'recent', color: '#3b82f6', icon: 'Clock' }
                ]},
                { type: 'chart', title: '월별 등록 현황', chartType: 'bar', dataField: 'created_at', label: '등록수' }
            ])
        };
    }
}

// ─────────────────────────────────────────────────────────────
// 6. Supabase 테이블 자동 생성 — pg 직접 연결 방식
// ─────────────────────────────────────────────────────────────
const { Pool } = require('pg');
const pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function createSupabaseTable(schema, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Supabase] 🗄️ 테이블 생성 중: ${schema.tableName}...` : `[Supabase] 🗄️ Creating table: ${schema.tableName}...`);
    try {
        await pgPool.query(schema.sqlCreate);
        await new Promise(r => setTimeout(r, 3000));
        sendLog(isKo ? `[Supabase] ✅ 테이블 생성 완료: ${schema.tableName}` : `[Supabase] ✅ Table created: ${schema.tableName}`);
        return true;
    } catch(e) {
        if (e.code === '42P07' || e.message.includes('already exists')) {
            sendLog(isKo ? `[Supabase] ✅ 테이블 이미 존재: ${schema.tableName}` : `[Supabase] ✅ Table exists: ${schema.tableName}`);
            await new Promise(r => setTimeout(r, 3000));
            return true;
        }
        sendLog(`⚠️ [Supabase] 테이블 생성 실패: ${e.message}`);
        return false;
    }
}

// ─────────────────────────────────────────────────────────────
// 7-1. 위젯 헬퍼 함수들
// ─────────────────────────────────────────────────────────────
function buildWidgetImports(featureSpec) {
    if (!featureSpec?.widgets?.length) return '';
    const SAFE_ICONS = new Set([
        'BookOpen','Calendar','CheckSquare','TrendingUp','Star','Clock',
        'BarChart2','Activity','Target','Award','Bookmark','List'
    ]);
    const icons = new Set();
    featureSpec.widgets.forEach(w => {
        if (w.type === 'stat_cards' && w.cards) {
            w.cards.forEach(c => { if (c.icon && SAFE_ICONS.has(c.icon)) icons.add(c.icon); });
        }
    });
    return icons.size ? ', ' + [...icons].join(', ') : '';
}

function buildWidgetHooks(featureSpec) {
    if (!featureSpec?.widgets?.some(w => w.type === 'chart')) return '';
    return `
  const monthlyData = useMemo(() => {
    const counts: Record<string, number> = {};
    items.forEach(item => {
      const month = new Date(item.created_at).toLocaleDateString('ko-KR', { month: 'short' });
      counts[month] = (counts[month] || 0) + 1;
    });
    return Object.entries(counts).slice(-6).map(([month, count]) => ({ month, count }));
  }, [items]);
`;
}

function buildWidgetJSX(featureSpec) {
    if (!featureSpec?.widgets?.length) return '';
    return featureSpec.widgets.map(w => {
        if (w.type === 'stat_cards') {
            const cards = (w.cards || []).map(card => {
                let valueExpr;
                if (card.field === 'total') valueExpr = 'items.length';
                else if (card.field === 'recent') valueExpr = 'items.filter(i => new Date(i.created_at) > new Date(Date.now()-7*86400000)).length';
                else valueExpr = `items.filter(i => i.${card.field}).length`;
                return `
          <div style={{background:'#1e1e1e',border:'1px solid #2a2a2a',borderRadius:'12px',padding:'20px 24px',flex:1,minWidth:'140px'}}>
            <p style={{color:'#888',fontSize:'13px',marginBottom:'8px'}}>${card.label}</p>
            <p style={{color:'${card.color}',fontSize:'2rem',fontWeight:900}}>{${valueExpr}}</p>
          </div>`;
            }).join('');
            return `
        <div style={{marginBottom:'24px'}}>
          <h2 style={{fontSize:'0.95rem',fontWeight:700,color:'#aaa',marginBottom:'12px'}}>${w.title}</h2>
          <div style={{display:'flex',gap:'16px',flexWrap:'wrap'}}>${cards}
          </div>
        </div>`;
        }
        if (w.type === 'chart') {
            return `
        {monthlyData.length > 0 && (
          <div style={{background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'12px',padding:'20px 24px',marginBottom:'24px'}}>
            <h2 style={{fontSize:'0.95rem',fontWeight:700,color:'#aaa',marginBottom:'16px'}}>${w.title}</h2>
            <div style={{display:'flex',alignItems:'flex-end',gap:'8px',height:'80px'}}>
              {monthlyData.map((d, i) => (
                <div key={i} style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',gap:'6px'}}>
                  <div style={{width:'100%',height:monthlyData.length>0?\`\${Math.round((d.count/Math.max(...monthlyData.map(x=>x.count)))*64)}px\`:'4px',background:'#FF2D20',borderRadius:'4px 4px 0 0',minHeight:'4px',transition:'height 0.3s ease'}}/>
                  <span style={{fontSize:'11px',color:'#666'}}>{d.month}</span>
                </div>
              ))}
            </div>
          </div>
        )}`;
        }
        if (w.type === 'comparison') {
            const cur = w.currentField;
            const thr = w.thresholdField;
            const nameField = w.nameField || cur;
            if (!cur || !thr) return '';
            return `
        <div style={{background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'12px',padding:'20px 24px',marginBottom:'24px'}}>
          <h2 style={{fontSize:'0.95rem',fontWeight:700,color:'#aaa',marginBottom:'12px'}}>${w.title}</h2>
          {(() => {
            const lowItems = items.filter((i: any) => i.${cur} != null && i.${thr} != null && Number(i.${cur}) < Number(i.${thr}));
            return (
              <div>
                <div style={{display:'flex',alignItems:'baseline',gap:'10px',marginBottom: lowItems.length > 0 ? '14px' : '0'}}>
                  <span style={{fontSize:'2rem',fontWeight:900,color: lowItems.length > 0 ? '#ef4444' : '#10b981'}}>{lowItems.length}</span>
                  <span style={{fontSize:'13px',color:'#888'}}>${w.label}</span>
                </div>
                {lowItems.length > 0 && (
                  <div style={{display:'flex',flexDirection:'column',gap:'8px'}}>
                    {lowItems.slice(0, 5).map((i: any, idx: number) => (
                      <div key={idx} style={{display:'flex',justifyContent:'space-between',alignItems:'center',background:'rgba(239,68,68,0.08)',border:'1px solid rgba(239,68,68,0.2)',borderRadius:'8px',padding:'8px 12px'}}>
                        <span style={{color:'#f1f1f1',fontSize:'13px',fontWeight:600}}>{i.${nameField} ?? '-'}</span>
                        <span style={{color:'#ef4444',fontSize:'12px'}}>현재 {i.${cur}} / 최소 {i.${thr}}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}
        </div>`;
        }
        return '';
    }).join('');
}

// ─────────────────────────────────────────────────────────────
// 7. 대시보드 페이지 자동 생성
// ─────────────────────────────────────────────────────────────
function buildDashboardPage(schema, featureSpec, supabaseUrl, supabaseAnonKey) {
    function toPgType(t) {
        const map = {
            text: 'text', string: 'text',
            integer: 'integer', int: 'integer',
            numeric: 'numeric', number: 'numeric', decimal: 'numeric', float: 'numeric',
            boolean: 'boolean', bool: 'boolean',
            date: 'date',
            timestamptz: 'timestamptz', timestamp: 'timestamptz'
        };
        return map[String(t || 'text').toLowerCase()] || 'text';
    }

    const userFields = schema.columns.filter(c =>
        !['id', 'user_id', 'created_at'].includes(c.name)
    );

    function getInputKind(f) {
        const pg = toPgType(f.type);
        if (pg === 'boolean') return 'boolean';
        if (pg === 'numeric' || pg === 'integer') return 'number';
        if (pg === 'date' || pg === 'timestamptz') return 'date';
        const nm = f.name.toLowerCase();
        if (nm.includes('date') || nm.includes('_at') || nm.startsWith('start') || nm.startsWith('end') || nm.includes('checkin') || nm.includes('check_in') || nm.includes('checkout') || nm.includes('check_out')) return 'date';
        if (nm.includes('phone') || nm.includes('tel') || nm.includes('contact')) return 'phone';
        return 'text';
    }

    const formFields = userFields.map(f => {
        const kind = getInputKind(f);
        const pg = toPgType(f.type);
        const label = f.label || f.name;
        const ph = f.placeholder || label;

        if (kind === 'boolean') {
            return `
              <div>
                <label style={{display:'flex',alignItems:'center',gap:'10px',fontSize:'14px',color:'#f1f1f1',cursor:'pointer'}}>
                  <input
                    type="checkbox"
                    checked={!!form['${f.name}']}
                    onChange={e => setForm({...form, "${f.name}": e.target.checked})}
                    style={{width:'18px',height:'18px',accentColor:'#FF2D20',cursor:'pointer'}}
                  />
                  ${label}
                </label>
              </div>`;
        }

        if (kind === 'number') {
            const step = pg === 'integer' ? '1' : 'any';
            const im = pg === 'integer' ? 'numeric' : 'decimal';
            return `
              <div>
                <label style={{display:'block',fontSize:'13px',color:'#aaa',marginBottom:'6px'}}>${label}</label>
                <input
                  type="number"
                  step="${step}"
                  inputMode="${im}"
                  placeholder="${ph}"
                  value={form['${f.name}'] ?? ''}
                  onChange={e => setForm({...form, "${f.name}": e.target.value})}
                  style={{width:'100%',background:'#111',border:'1px solid #333',borderRadius:'8px',padding:'10px 14px',color:'#fff',fontSize:'14px'}}
                />
              </div>`;
        }

        if (kind === 'date') {
            return `
              <div>
                <label style={{display:'block',fontSize:'13px',color:'#aaa',marginBottom:'6px'}}>${label}</label>
                <input
                  type="date"
                  value={form['${f.name}'] ?? ''}
                  onChange={e => setForm({...form, "${f.name}": e.target.value})}
                  style={{width:'100%',background:'#111',border:'1px solid #333',borderRadius:'8px',padding:'10px 14px',color:'#fff',fontSize:'14px',colorScheme:'dark'}}
                />
              </div>`;
        }

        const inputType = kind === 'phone' ? 'tel' : 'text';
        return `
              <div>
                <label style={{display:'block',fontSize:'13px',color:'#aaa',marginBottom:'6px'}}>${label}</label>
                <input
                  type="${inputType}"
                  placeholder="${ph}"
                  value={form['${f.name}'] ?? ''}
                  onChange={e => setForm({...form, "${f.name}": e.target.value})}
                  style={{width:'100%',background:'#111',border:'1px solid #333',borderRadius:'8px',padding:'10px 14px',color:'#fff',fontSize:'14px'}}
                />
              </div>`;
    }).join('');

    const booleanDefaults = userFields
        .filter(f => toPgType(f.type) === 'boolean')
        .map(f => `'${f.name}': false`)
        .join(', ');

    const listFields = schema.listFields?.length ? schema.listFields : [schema.primaryField];
    const listHeaders = listFields.map(f => {
        const col = userFields.find(c => c.name === f);
        return `<th style={{padding:'12px 16px',textAlign:'left',fontSize:'12px',color:'#888',fontWeight:600,textTransform:'uppercase',letterSpacing:'1px'}}>${col ? col.label : f}</th>`;
    }).join('\n                  ');
    const listCells = listFields.map(f => {
        const col = userFields.find(c => c.name === f);
        const pg = col ? toPgType(col.type) : 'text';
        if (pg === 'boolean') {
            return `<td style={{padding:'12px 16px',color:'#ccc',fontSize:'14px'}}>{item['${f}'] === true ? '예' : item['${f}'] === false ? '아니오' : '-'}</td>`;
        }
        return `<td style={{padding:'12px 16px',color:'#ccc',fontSize:'14px'}}>{item['${f}'] ?? '-'}</td>`;
    }).join('\n                  ');

    const insertFields = userFields.map(f => {
        const pg = toPgType(f.type);
        if (pg === 'boolean') {
            return `'${f.name}': !!form['${f.name}']`;
        }
        if (pg === 'numeric' || pg === 'integer') {
            return `'${f.name}': (form['${f.name}'] === '' || form['${f.name}'] === undefined || form['${f.name}'] === null) ? null : Number(form['${f.name}'])`;
        }
        return `'${f.name}': form['${f.name}'] || null`;
    }).join(', ');

    // 수정 시작 시 폼에 기존 값 로드 (boolean은 false, 나머지는 '' 기본)
    const editLoaders = userFields.map(f =>
        `next['${f.name}'] = item['${f.name}'] ?? ${toPgType(f.type) === 'boolean' ? 'false' : "''"};`
    ).join('\n    ');

    const widgetImports = buildWidgetImports(featureSpec);
    const widgetHooks = buildWidgetHooks(featureSpec);
    const widgetJSX = buildWidgetJSX(featureSpec);
    const needsUseMemo = featureSpec?.widgets?.some(w => w.type === 'chart');

    return `"use client";
import { useState, useEffect${needsUseMemo ? ', useMemo' : ''} } from 'react';
import { createClient } from '@supabase/supabase-js';
import { Plus, Trash2, LogOut, Pencil${widgetImports} } from 'lucide-react';

const supabase = createClient('${supabaseUrl}', '${supabaseAnonKey}', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: 'vx-auth-token',
  }
});

export default function Dashboard() {
  const initialForm: Record<string, any> = { ${booleanDefaults} };
  const [user, setUser] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]);
  const [form, setForm] = useState<Record<string, any>>(initialForm);
  const [loading, setLoading] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recentPayments, setRecentPayments] = useState<any[]>([]);
${widgetHooks}
  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { window.location.href = '/auth'; return; }
      setUser(data.user);
      fetchItems(data.user.id);
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    const fetchPayments = async () => {
      try {
        const { data } = await supabase
          .from('payments')
          .select('*')
          .eq('user_id', user.id)
          .eq('status', 'completed')
          .order('created_at', { ascending: false })
          .limit(3);
        if (data) setRecentPayments(data);
      } catch(e) {}
    };
    fetchPayments();
  }, [user]);

  const fetchItems = async (userId: string) => {
    const { data } = await supabase
      .from('${schema.tableName}')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });
    setItems(data || []);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setLoading(true);
    setErrorMsg('');
    const payload = { ${insertFields} };
    let error;
    if (editingId) {
      const res = await supabase.from('${schema.tableName}').update(payload).eq('id', editingId);
      error = res.error;
    } else {
      const res = await supabase.from('${schema.tableName}').insert({ ...payload, user_id: user.id });
      error = res.error;
    }
    if (error) {
      const code = (error as any).code;
      if (code === '23505') {
        setErrorMsg('이미 등록된 항목입니다. 중복된 값이 있는지 확인해 주세요.');
      } else if (code === '23514') {
        setErrorMsg('값이 0보다 작을 수 없습니다. 다시 확인해 주세요.');
      } else if (code === '23502') {
        setErrorMsg('필수 항목을 모두 입력해 주세요.');
      } else {
        setErrorMsg('저장에 실패했습니다. 입력값을 확인한 후 다시 시도해 주세요.');
      }
    } else {
      setForm({ ...initialForm });
      setShowForm(false);
      setEditingId(null);
      fetchItems(user.id);
    }
    setLoading(false);
  };

  const startEdit = (item: any) => {
    const next: Record<string, any> = { ...initialForm };
    ${editLoaders}
    setForm(next);
    setEditingId(item.id);
    setErrorMsg('');
    setShowForm(true);
  };

  const handleDelete = async (id: string) => {
    await supabase.from('${schema.tableName}').delete().eq('id', id);
    if (editingId === id) { setEditingId(null); setForm({ ...initialForm }); setShowForm(false); }
    if (user) fetchItems(user.id);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  if (!user) return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <p style={{color:'#888'}}>로딩 중...</p>
    </div>
  );

  return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',padding:'24px'}}>
      <div style={{maxWidth:'1100px',margin:'0 auto'}}>

        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:'32px'}}>
          <div>
            <h1 style={{fontSize:'1.8rem',fontWeight:900,color:'#fff'}}>${schema.displayName}</h1>
            <p style={{color:'#888',fontSize:'14px',marginTop:'4px'}}>{user.email}</p>
          </div>
          <div style={{display:'flex',gap:'12px'}}>
            <button onClick={() => { setEditingId(null); setForm({ ...initialForm }); setErrorMsg(''); setShowForm(true); }}
              style={{display:'flex',alignItems:'center',gap:'8px',background:'#FF2D20',color:'#fff',border:'none',borderRadius:'8px',padding:'10px 20px',fontWeight:700,cursor:'pointer',fontSize:'14px'}}>
              <Plus size={16}/> 새로 추가
            </button>
            <button onClick={handleLogout}
              style={{display:'flex',alignItems:'center',gap:'8px',background:'#1a1a1a',color:'#aaa',border:'1px solid #333',borderRadius:'8px',padding:'10px 20px',fontWeight:600,cursor:'pointer',fontSize:'14px'}}>
              <LogOut size={16}/> 로그아웃
            </button>
          </div>
        </div>

        {recentPayments.length > 0 && (
          <div style={{background:'linear-gradient(135deg,rgba(16,185,129,0.1),rgba(59,130,246,0.05))',border:'1px solid rgba(16,185,129,0.2)',borderRadius:'12px',padding:'16px 20px',marginBottom:'24px'}}>
            <p style={{color:'#10b981',fontSize:'12px',fontWeight:700,marginBottom:'10px'}}>최근 결제 알림</p>
            {recentPayments.map((p: any, i: number) => (
              <div key={i} style={{display:'flex',justifyContent:'space-between',alignItems:'center',padding:'6px 0',borderBottom:i < recentPayments.length - 1 ? '1px solid rgba(255,255,255,0.05)' : 'none'}}>
                <span style={{color:'#ccc',fontSize:'13px'}}>{p.email}</span>
                <div style={{display:'flex',alignItems:'center',gap:'8px'}}>
                  <span style={{color:'#10b981',fontSize:'13px',fontWeight:700}}>{p.currency === 'usd' ? '$' : p.currency}{(p.amount / 100).toFixed(2)}</span>
                  <span style={{color:'#666',fontSize:'11px'}}>{new Date(p.created_at).toLocaleDateString('ko-KR')}</span>
                </div>
              </div>
            ))}
          </div>
        )}
        
        ${widgetJSX}

        {showForm && (
          <div style={{background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'12px',padding:'24px',marginBottom:'24px'}}>
            <h2 style={{fontSize:'1.1rem',fontWeight:700,color:'#fff',marginBottom:'20px'}}>{editingId ? '항목 수정' : '새 항목 추가'}</h2>
            <form onSubmit={handleSubmit} style={{display:'flex',flexDirection:'column',gap:'16px'}}>
              ${formFields}
              {errorMsg && <p style={{color:'#f87171',fontSize:'13px'}}>{errorMsg}</p>}
              <div style={{display:'flex',gap:'12px',marginTop:'8px'}}>
                <button type="submit" disabled={loading}
                  style={{background:'#FF2D20',color:'#fff',border:'none',borderRadius:'8px',padding:'12px 24px',fontWeight:700,cursor:'pointer',fontSize:'14px'}}>
                  {loading ? '저장 중...' : (editingId ? '수정 저장' : '저장')}
                </button>
                <button type="button" onClick={() => { setShowForm(false); setEditingId(null); setErrorMsg(''); }}
                  style={{background:'transparent',color:'#aaa',border:'1px solid #333',borderRadius:'8px',padding:'12px 24px',fontWeight:600,cursor:'pointer',fontSize:'14px'}}>
                  취소
                </button>
              </div>
            </form>
          </div>
        )}

        <div style={{background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'12px',overflow:'hidden'}}>
          <div style={{padding:'16px 20px',borderBottom:'1px solid #2a2a2a'}}>
            <h2 style={{fontSize:'1rem',fontWeight:700,color:'#fff'}}>전체 목록 <span style={{color:'#FF2D20',marginLeft:'8px'}}>{items.length}</span></h2>
          </div>
          {items.length === 0 ? (
            <div style={{padding:'48px',textAlign:'center',color:'#555'}}>
              <p style={{fontSize:'16px',marginBottom:'8px'}}>아직 항목이 없습니다</p>
              <p style={{fontSize:'13px'}}>위의 "새로 추가" 버튼을 눌러 시작하세요</p>
            </div>
          ) : (
            <table style={{width:'100%',borderCollapse:'collapse'}}>
              <thead>
                <tr style={{borderBottom:'1px solid #2a2a2a',background:'#111'}}>
                  ${listHeaders}
                  <th style={{padding:'12px 16px',textAlign:'left',fontSize:'12px',color:'#888',fontWeight:600,textTransform:'uppercase',letterSpacing:'1px'}}>날짜</th>
                  <th style={{padding:'12px 16px',width:'90px'}}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} style={{borderBottom:'1px solid #1e1e1e',transition:'background 0.15s'}}
                    onMouseEnter={e=>(e.currentTarget.style.background='#222')}
                    onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>
                    ${listCells}
                    <td style={{padding:'12px 16px',color:'#666',fontSize:'13px'}}>
                      {new Date(item.created_at).toLocaleDateString('ko-KR')}
                    </td>
                    <td style={{padding:'12px 16px'}}>
                      <div style={{display:'flex',gap:'4px'}}>
                        <button onClick={() => startEdit(item)}
                          style={{background:'transparent',border:'none',color:'#555',cursor:'pointer',padding:'4px'}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#3b82f6')}
                          onMouseLeave={e=>(e.currentTarget.style.color='#555')}>
                          <Pencil size={16}/>
                        </button>
                        <button onClick={() => handleDelete(item.id)}
                          style={{background:'transparent',border:'none',color:'#555',cursor:'pointer',padding:'4px'}}
                          onMouseEnter={e=>(e.currentTarget.style.color='#FF2D20')}
                          onMouseLeave={e=>(e.currentTarget.style.color='#555')}>
                          <Trash2 size={16}/>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p style={{textAlign:'center',color:'#333',fontSize:'12px',marginTop:'32px'}}>
          <a href="/" style={{color:'#555',textDecoration:'none'}}>← 홈으로</a>
        </p>
      </div>
    </div>
  );
}
`;
}

// ─────────────────────────────────────────────────────────────
// 8. JSON 콘텐츠 생성
// ─────────────────────────────────────────────────────────────
const KO_MAP = {
    navbar: {
        btn_secondary: '로그인',
        btn_primary: '무료 시작',
        link_map: {
            'features': '기능', 'pricing': '가격', 'blog': '블로그',
            'about': '소개', 'contact': '문의', 'solutions': '솔루션',
            'use cases': '사례', 'docs': '문서', 'company': '회사',
            'product': '제품', 'enterprise': '기업', 'resources': '자료',
            'how it works': '작동 방식', 'faq': 'FAQ', 'support': '지원',
            'customers': '고객', 'partners': '파트너', 'careers': '채용',
            'integrations': '연동', 'changelog': '업데이트', 'login': '로그인',
            'sign up': '회원가입', 'demo': '데모', 'case studies': '사례 연구',
            'home': '홈', 'stats': '통계', 'settings': '설정', 'dashboard': '대시보드',
            'my books': '내 서재', 'my notes': '내 노트', 'my profile': '내 프로필',
            'my account': '내 계정', 'my projects': '내 프로젝트', 'my tasks': '내 할일',
            'reviews': '리뷰', 'books': '도서', 'library': '서재', 'profile': '프로필',
            'explore': '탐색', 'community': '커뮤니티', 'news': '뉴스', 'events': '이벤트',
            'services': '서비스', 'portfolio': '포트폴리오', 'team': '팀', 'jobs': '채용',
            'templates': '템플릿', 'roadmap': '로드맵', 'press': '보도자료', 'security': '보안', 'help': '도움말', 'guides': '가이드',
        }
    },
    hero: { btn_primary: '시작하기', btn_secondary: '데모 보기' },
    features: { label: '핵심 기능' },
    stats: { label: '성과 지표' },
    footer: {
        newsletter_title: '뉴스레터 구독',
        newsletter_placeholder: '이메일 주소 입력',
        newsletter_btn: '구독하기',
        col_titles: ['제품', '회사', '법적고지'],
        col_links: [
            ['기능', '가격', '업데이트'],
            ['소개', '블로그', '채용'],
            ['개인정보처리방침', '이용약관', '쿠키 정책'],
        ],
    },
};

function applyKoMap(json) {
    json.navbar.btn_secondary = { ko: KO_MAP.navbar.btn_secondary, en: json.navbar.btn_secondary_en };
    json.navbar.btn_primary   = { ko: KO_MAP.navbar.btn_primary,   en: json.navbar.btn_primary_en };
    json.navbar.links = json.navbar.links || [];
json.navbar.links_i18n = json.navbar.links.map(l => {
    if (typeof l === 'object' && l.text_ko) {
        return { ko: l.text_ko, en: l.text_en || l.text_ko, anchor: l.anchor || '' };
    }
    return { en: l, ko: KO_MAP.navbar.link_map[String(l).toLowerCase()] || KO_MAP.navbar.link_map[String(l).toLowerCase().replace(/s$/, '')] || l, anchor: '' };
});
    json.hero.label       = { ko: json.hero.label_ko,    en: json.hero.label_en };
    json.hero.title       = { ko: json.hero.title_ko,    en: json.hero.title_en };
    json.hero.subtitle    = { ko: json.hero.subtitle_ko, en: json.hero.subtitle_en };
    json.hero.btn_primary = { ko: KO_MAP.hero.btn_primary,   en: json.hero.btn_primary_en };
    json.hero.btn_secondary={ ko: KO_MAP.hero.btn_secondary, en: json.hero.btn_secondary_en };
    json.hero.stats = json.hero.stats.map(s => ({ number: s.number, label: { ko: s.label_ko, en: s.label_en } }));
    json.features.label    = { ko: KO_MAP.features.label, en: json.features.label_en };
    json.features.title    = { ko: json.features.title_ko, en: json.features.title_en };
    json.features.subtitle = { ko: json.features.subtitle_ko, en: json.features.subtitle_en };
    json.features.items = json.features.items.map(item => ({
        icon: item.icon, image_seed: item.image_seed,
        tag: { ko: item.tag_ko, en: item.tag_en },
        title: { ko: item.title_ko, en: item.title_en },
        desc: { ko: item.desc_ko, en: item.desc_en },
    }));
    json.stats.label    = { ko: KO_MAP.stats.label, en: json.stats.label_en };
    json.stats.title    = { ko: json.stats.title_ko, en: json.stats.title_en };
    json.stats.subtitle = { ko: json.stats.subtitle_ko, en: json.stats.subtitle_en };
    json.stats.items = json.stats.items.map(item => ({
        number: item.number,
        label: { ko: item.label_ko, en: item.label_en },
        desc: { ko: item.desc_ko, en: item.desc_en },
    }));
    json.footer.tagline = { ko: json.footer.tagline_ko, en: json.footer.tagline_en };
    if (json.pricing && json.pricing.plans) {
        json.pricing.plans = json.pricing.plans.map(plan => ({
            name: { ko: plan.name_ko || plan.name || plan.name_en, en: plan.name_en || plan.name || plan.name_ko },
            price: plan.price,
            period: { ko: plan.period_ko || plan.period || '', en: plan.period_en || plan.period || '' },
            features: {
                ko: plan.features_ko || plan.features || [],
                en: plan.features_en || plan.features || []
            },
            cta: { ko: plan.cta_ko || plan.cta || '', en: plan.cta_en || plan.cta || '' },
            highlight: plan.highlight || false
        }));
    }
    if (json.faq && json.faq.items) {
        json.faq.items = json.faq.items.map(item => ({
            q: { ko: item.q_ko || item.q || '', en: item.q_en || item.q || '' },
            a: { ko: item.a_ko || item.a || '', en: item.a_en || item.a || '' }
        }));
    }
    json.footer.newsletter = {
        title:       { ko: KO_MAP.footer.newsletter_title,       en: json.footer.newsletter_title_en },
        placeholder: { ko: KO_MAP.footer.newsletter_placeholder, en: 'Enter your email' },
        btn:         { ko: KO_MAP.footer.newsletter_btn,         en: 'Subscribe' },
    };
    json.footer.columns = json.footer.columns.map((col, ci) => ({
        title: { ko: KO_MAP.footer.col_titles[ci] || col.title_en, en: col.title_en },
        links: col.links_en.map((l, li) => ({
            ko: (KO_MAP.footer.col_links[ci] || [])[li] || l, en: l,
        })),
    }));
    return json;
}

async function generateContentJSON(idea, sendLog, lang = 'ko', prd = '') {
    const isKo = lang === 'ko';
    sendLog(`[Claude] 📝 콘텐츠 JSON 생성 중...`);
    const prompt = `Content strategist. Idea: "${idea}"
PRD: "${prd}"
Output ONLY valid JSON. No markdown. ASCII-safe strings only.

Required structure:
{"navbar":{"logo":"BrandName","links":[{"text_ko":"한국어메뉴1","text_en":"English1","anchor":"hero"},{"text_ko":"한국어메뉴2","text_en":"English2","anchor":"features"},{"text_ko":"한국어메뉴3","text_en":"English3","anchor":"pricing"},{"text_ko":"한국어메뉴4","text_en":"English4","anchor":"faq"}],"btn_secondary_en":"Login","btn_primary_en":"Get Started"},"hero":{"label_en":"..","label_ko":"..","title_en":"..","title_ko":"..","subtitle_en":"..","subtitle_ko":"..","btn_primary_en":"..","btn_secondary_en":"..","stats":[{"number":"..","label_en":"..","label_ko":".."}]},"features":{"label_en":"Features","title_en":"..","title_ko":"..","subtitle_en":"..","subtitle_ko":"..","items":[{"icon":"IconName","image_seed":"noun","tag_en":"..","tag_ko":"..","title_en":"..","title_ko":"..","desc_en":"2-3 sentences","desc_ko":"2-3 sentences"}]},"stats":{"label_en":"Performance","title_en":"..","title_ko":"..","subtitle_en":"..","subtitle_ko":"..","items":[{"number":"..","label_en":"..","label_ko":"..","desc_en":"..","desc_ko":".."}]},"pricing":{"plans":[{"name_en":"..","name_ko":"..","price":"$X","period_en":"..","period_ko":"..","features_en":[".."],"features_ko":[".."],"cta_en":"..","cta_ko":"..","highlight":false}]},"faq":{"items":[{"q_en":"..","q_ko":"..","a_en":"..","a_ko":".."}]},"footer":{"logo":"BrandName","tagline_en":"..","tagline_ko":"..","newsletter_title_en":"Newsletter","columns":[{"title_en":"Product","links_en":["Features","Pricing","Changelog"]},{"title_en":"Company","links_en":["About","Blog","Careers"]},{"title_en":"Legal","links_en":["Privacy","Terms","Cookies"]}],"copyright":"BrandName"}}

RULES:
- navbar.links: exactly 4 objects. Each object: {"text_ko":"Korean menu","text_en":"English menu","anchor":"sectionId"}. anchor MUST be one of: hero, features, stats, pricing, faq, cta. No duplicates. Choose the most relevant section for each menu item.
- hero.stats: exactly 4 items. Realistic goal numbers.
- features.items: 4-6 items. icon=valid lucide-react name(Zap/Shield/Brain/BarChart2/Globe/Lock/Star/Target). image_seed=MUST be a specific concrete English noun that visually represents THAT feature(e.g. for pet app:"dog","bath","leash"; for food app:"kitchen","plate","chef"). NEVER use generic words like "technology","security","innovation","solution". desc_ko=MUST be 2-3 full sentences(50-100chars) explaining what the feature does specifically. NEVER write vague one-liners.
- stats.items: 3-4 items. desc_ko under 15chars. IMPORTANT: Determine if this is a NEW service (no existing users/data) or an EXISTING service (has real metrics). For NEW services: use service promises/specs instead of fake user counts (e.g. "24/7", "3min Setup", "99.9% Uptime", "0 Coding Required"). NEVER use fake numbers like "120K+ Users" or "500+ Companies" for new services. For EXISTING services: use realistic achievement numbers.
- pricing.plans: 2-4 plans. Simple tools=2(Free+Pro). SaaS=3(Free+Pro+Business). Only one highlight=true. name_ko/name_en: plan name in both languages (e.g. name_en:"Free", name_ko:"무료"). period_ko/period_en: billing period (e.g. period_en:"/mo", period_ko:"/월"). features_ko/features_en: feature list in both languages. cta_ko/cta_en: button text (e.g. cta_en:"Get Started", cta_ko:"시작하기"). price: If the user mentioned a specific price in their idea or PRD, you MUST use that exact price. Do NOT override user-specified pricing with your own numbers. If no price was mentioned, use reasonable defaults (e.g. "$0", "$29").
- faq.items: 3-5 Q&A pairs. Specific to this idea. q_ko/q_en: question in both languages. a_ko/a_en: answer in both languages.
- footer.columns: exactly 3.
- All _ko values: SHORT ${isKo ? 'Korean' : 'English'} under 10chars. Exception: desc_ko can be longer.
- Output ONLY JSON.`;

    const result = await anthropic.messages.create({
        model: MODEL_CODER,
        max_tokens: 8192,
        messages: [{ role: "user", content: prompt }]
    });

    const raw = result.content[0].text.trim()
        .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

    let json;
    try {
        json = JSON.parse(raw);
    } catch(e) {
        sendLog(`[Claude] ⚠️ JSON 파싱 실패 재시도...`);
        const retry = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 8192,
            messages: [
                { role: "user", content: prompt },
                { role: "assistant", content: result.content[0].text },
                { role: "user", content: "The JSON was cut off or invalid. Output the COMPLETE valid JSON again. No markdown. Start with { and end with }." }
            ]
        });
        const retryRaw = retry.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
        json = JSON.parse(retryRaw);
    }
    // ───── 사용자 입력 가격 후처리 ─────
    // 1순위: idea에서 가격 추출 (사용자가 직접 명시한 가격)
    let dollarPrices = (idea.match(/\$\d+(?:\.\d{1,2})?/g) || []).map(p => p);
    let wonPrices = (idea.match(/₩[\d,]+|[\d,]+원/g) || []).map(p => {
        const num = p.replace(/[₩원,]/g, '');
        return `₩${Number(num).toLocaleString()}`;
    });
    // 2순위: idea에 가격이 없으면 PRD에서 "Pricing:" 또는 "pricing:" 문맥의 가격만 추출
    if (dollarPrices.length === 0 && wonPrices.length === 0 && prd) {
        const pricingMatch = prd.match(/[Pp]ricing[:\s]+\$\d+(?:\.\d{1,2})?/g) || [];
        const premiumMatch = prd.match(/\$\d+(?:\.\d{1,2})?\/month\s+(?:for\s+)?premium/gi) || [];
        const prdPriceMatches = [...pricingMatch, ...premiumMatch];
        dollarPrices = (prdPriceMatches.join(' ').match(/\$\d+(?:\.\d{1,2})?/g) || []);
        const prdWonMatches = prd.match(/[Pp]ricing[:\s]+(?:₩[\d,]+|[\d,]+원)/g) || [];
        wonPrices = (prdWonMatches.join(' ').match(/₩[\d,]+|[\d,]+원/g) || []).map(p => {
            const num = p.replace(/[₩원,]/g, '');
            return `₩${Number(num).toLocaleString()}`;
        });
    }
    const userPrices = isKo ? [...wonPrices, ...dollarPrices] : dollarPrices;

    if (userPrices.length > 0 && json.pricing && json.pricing.plans) {
        const sorted = userPrices.length === 1
            ? [userPrices[0]]
            : userPrices.sort((a, b) => {
                const numA = parseFloat(a.replace(/[^0-9.]/g, ''));
                const numB = parseFloat(b.replace(/[^0-9.]/g, ''));
                return numA - numB;
            });

        const plans = json.pricing.plans;
        if (sorted.length === 1) {
            const highlightIdx = plans.findIndex(p => p.highlight);
            if (highlightIdx !== -1) plans[highlightIdx].price = sorted[0];
            else if (plans.length >= 2) plans[1].price = sorted[0];
        } else {
            const paidPlans = plans.filter(p => p.price !== '$0' && p.price !== '무료' && p.price !== 'Free');
            sorted.forEach((price, i) => {
                if (i < paidPlans.length) paidPlans[i].price = price;
            });
        }
    }

    return applyKoMap(json);
}

// ─────────────────────────────────────────────────────────────
// 9-D-1. AI 생성 코드에 data-vp-id 자동 주입 (텍스트 매칭 방식)
// AI가 생성한 코드의 텍스트를 contentJson과 매칭하여 data-vp-id 부착
// ─────────────────────────────────────────────────────────────
function injectVpIdsByText(componentCode, contentJson, sectionName) {
    if (!componentCode || !contentJson) return componentCode;

    // 섹션별 ID 매핑 정의
    const sectionMap = {
        HeroSection: [
            { id: 'hero-title', text: contentJson?.hero?.title?.ko },
            { id: 'hero-title-en', text: contentJson?.hero?.title?.en, alias: 'hero-title' },
            { id: 'hero-subtitle', text: contentJson?.hero?.subtitle?.ko },
            { id: 'hero-subtitle-en', text: contentJson?.hero?.subtitle?.en, alias: 'hero-subtitle' },
            { id: 'hero-label', text: contentJson?.hero?.label?.ko },
            { id: 'hero-label-en', text: contentJson?.hero?.label?.en, alias: 'hero-label' }
        ],
        FeatureSection: [
            { id: 'feat-title', text: contentJson?.features?.title?.ko },
            { id: 'feat-title-en', text: contentJson?.features?.title?.en, alias: 'feat-title' },
            { id: 'feat-subtitle', text: contentJson?.features?.subtitle?.ko },
            { id: 'feat-subtitle-en', text: contentJson?.features?.subtitle?.en, alias: 'feat-subtitle' }
        ],
        StatsSection: [
            { id: 'stat-title', text: contentJson?.stats?.title?.ko },
            { id: 'stat-title-en', text: contentJson?.stats?.title?.en, alias: 'stat-title' },
            { id: 'stat-subtitle', text: contentJson?.stats?.subtitle?.ko },
            { id: 'stat-subtitle-en', text: contentJson?.stats?.subtitle?.en, alias: 'stat-subtitle' }
        ],
        CTASection: [
            { id: 'cta-title', text: '지금 바로 시작하세요' },
            { id: 'cta-title-en', text: 'Get Started Today', alias: 'cta-title' }
        ]
    };

    const targets = sectionMap[sectionName];
    if (!targets) return componentCode;

    let result = componentCode;

    for (const target of targets) {
        if (!target.text || typeof target.text !== 'string' || target.text.length < 2) continue;

        // 이미 data-vp-id가 부착된 경우 스킵 (Day 2-B 폴백 코드)
        const finalId = target.alias || target.id;
        if (result.includes(`data-vp-id="${finalId}"`)) continue;

        // 텍스트 정규식 이스케이프
        const escapedText = target.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "\\\\?'");

        // 텍스트를 직접 감싸는 JSX 태그 찾기
        // 패턴: <태그 ...속성...>텍스트</태그> 또는 <태그 ...속성...>{...텍스트...}</태그>
        const pattern = new RegExp(
            `(<([a-zA-Z][a-zA-Z0-9]*)((?:\\s+[a-zA-Z-]+(?:=(?:"[^"]*"|'[^']*'|\\{[^}]*\\}))?)*)\\s*>)([^<]*?${escapedText}[^<]*?)(</\\2>)`,
            'g'
        );

        // 첫 매치만 처리 (가장 먼저 나오는 텍스트만 ID 부여)
        const match = pattern.exec(result);
        if (!match) continue;

        const fullMatch = match[0];
        const openTag = match[1];
        const tagName = match[2];
        const attrs = match[3] || '';
        const content = match[4];
        const closeTag = match[5];

        // 이미 data-vp-id가 attrs에 있으면 스킵
        if (attrs.includes('data-vp-id=')) continue;

        // data-vp-id 주입한 새 open tag 생성
        const newOpenTag = `<${tagName}${attrs} data-vp-id="${finalId}">`;
        const replacement = newOpenTag + content + closeTag;

        result = result.substring(0, match.index) + replacement + result.substring(match.index + fullMatch.length);
    }

    return result;
}

// ─────────────────────────────────────────────────────────────
// 9-E. 섹션 ID 강제 주입 (AI가 id 누락 시 후처리로 보정)
// ─────────────────────────────────────────────────────────────
function ensureSectionId(code, sectionName) {
    const ID_MAP = {
        HeroSection: 'hero',
        FeatureSection: 'features',
        StatsSection: 'stats',
        PricingSection: 'pricing',
        FAQSection: 'faq',
        CTASection: 'cta'
    };
    const targetId = ID_MAP[sectionName];
    if (!targetId) return code;
    if (code.includes(`id="${targetId}"`) || code.includes(`id='${targetId}'`)) return code;
    const sectionMatch = code.match(/(<section\s)/);
    if (sectionMatch) {
        return code.replace(/(<section\s)/, `$1id="${targetId}" `);
    }
    const returnMatch = code.match(/(return\s*\(\s*<)(div|main|article)(\s)/);
    if (returnMatch) {
        return code.replace(/(return\s*\(\s*<)(div|main|article)(\s)/, `$1$2 id="${targetId}"$3`);
    }
    return code;
}

// ─────────────────────────────────────────────────────────────
// 9-E-2. CTA 버튼 후처리 (AI가 <button> 또는 <Button>으로 생성 시 <a href="/auth">로 교체)
// ─────────────────────────────────────────────────────────────
function ensureCTALinks(code, sectionName) {
    const TARGET_SECTIONS = ['CTASection', 'PricingSection', 'HeroSection'];
    if (!TARGET_SECTIONS.includes(sectionName)) return code;

    let result = code;

    // 패턴 A: ShadCN <Button ...>텍스트</Button> → <a href="/auth" ...>텍스트</a>
    result = result.replace(
        /<Button([^>]*)>([\s\S]*?)<\/Button>/g,
        (match, attrs, content) => {
            if (attrs.includes('onClick')) return match;
            if (attrs.includes('type="submit"') || attrs.includes("type='submit'")) return match;
            if (attrs.includes('href=')) return match;
            let cleanAttrs = attrs
                .replace(/\s*variant=["'][^"']*["']/g, '')
                .replace(/\s*size=["'][^"']*["']/g, '')
                .replace(/\s*asChild/g, '')
                .trim();
            return `<a href="/auth" className="vx-btn-primary"${cleanAttrs ? ' ' + cleanAttrs : ''}>${content}</a>`;
        }
    );

    // 패턴 B: <button ...className="vx-btn-primary/secondary"...>텍스트</button>
    result = result.replace(
        /<button([^>]*className=["'][^"']*vx-btn-(primary|secondary)[^"']*["'][^>]*)>([\s\S]*?)<\/button>/g,
        (match, attrs, btnType, content) => {
            if (attrs.includes('href=')) return match;
            if (attrs.includes('onClick')) return match;
            if (attrs.includes('type="submit"') || attrs.includes("type='submit'")) return match;
            let cleanAttrs = attrs.replace(/\s*type=["'][^"']*["']/g, '').trim();
            return `<a href="/auth"${cleanAttrs ? ' ' + cleanAttrs : ''}>${content}</a>`;
        }
    );

    // 패턴 C: CTA/Pricing 섹션 내 onClick 없는 순수 <button>
    if (sectionName === 'CTASection' || sectionName === 'PricingSection') {
        result = result.replace(
            /<button([^>]*)>([\s\S]*?)<\/button>/g,
            (match, attrs, content) => {
                if (attrs.includes('onClick')) return match;
                if (attrs.includes('type="submit"') || attrs.includes("type='submit'")) return match;
                if (attrs.includes('href=')) return match;
                return `<a href="/auth"${attrs}>${content}</a>`;
            }
        );
    }

    return result;
}

// ─────────────────────────────────────────────────────────────
// 9-F. 방향 B 후처리: AI 생성 코드의 텍스트를 contentJson으로 강제 교체
// AI의 다양한 디자인(레이아웃/스타일)은 유지하되,
// 텍스트만 contentJson 바인딩으로 교체하여 C-2/C-5/C-6 동시 해결
// ─────────────────────────────────────────────────────────────
function replaceTextWithContentJson(code, contentJson, sectionName) {
    if (!code || !contentJson) return code;

    let result = code;

    // lang 변수 선언이 없으면 추가 (함수 본문 시작 직후)
    if (!result.includes("const lang =") && !result.includes("const lang=")) {
        result = result.replace(
            /(export default function \w+\(\)\s*\{)/,
            `$1\n  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';`
        );
    }

    // 안전한 이스케이프 헬퍼
    const safe = (str) => {
        if (!str || typeof str !== 'string') return '';
        return str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/\r/g, '').trim();
    };

    // lang 삼항 바인딩 생성 헬퍼
    const langBind = (ko, en) => {
        const safeKo = safe(ko);
        const safeEn = safe(en);
        if (!safeKo && !safeEn) return null;
        return `{lang==='ko'?'${safeKo}':'${safeEn}'}`;
    };

    try {
        if (sectionName === 'HeroSection') {
            result = replaceHeroText(result, contentJson, langBind);
        } else if (sectionName === 'FeatureSection') {
            result = replaceFeatureText(result, contentJson, langBind);
        } else if (sectionName === 'StatsSection') {
            result = replaceStatsText(result, contentJson, langBind);
        } else if (sectionName === 'PricingSection') {
            result = replacePricingText(result, contentJson, langBind);
        } else if (sectionName === 'FAQSection') {
            result = replaceFAQText(result, contentJson, langBind);
        } else if (sectionName === 'CTASection') {
            result = replaceCTAText(result, contentJson, langBind);
        }
    } catch (err) {
        // 교체 중 에러 발생 시 원본 유지 (안전 폴백)
        console.log(`[Direction-B] ⚠️ ${sectionName} text replacement failed: ${err.message}. Keeping original.`);
        return code;
    }

    return result;
}

// ───── Hero 텍스트 교체 ─────
function replaceHeroText(code, json, langBind) {
    const hero = json.hero;
    if (!hero) return code;
    let result = code;

    // 전략: AI가 생성한 텍스트의 정확한 위치를 모르므로,
    // <h1> 태그 안의 내용 전체를 contentJson으로 교체
    // <h1 ...>어떤텍스트든</h1> → <h1 ...>{lang바인딩}</h1>

    // h1 (메인 타이틀) — 첫 번째 <h1> 무조건 교체 (방향 B v3)
    if (hero.title?.ko && hero.title?.en) {
        const bind = langBind(hero.title.ko, hero.title.en);
        if (bind) {
            let h1Count = 0;
            result = result.replace(
                /(<h1[^>]*>)([\s\S]*?)(<\/h1>)/g,
                (match, open, content, close) => {
                    h1Count++;
                    if (h1Count === 1) {
                        return `${open}${bind}${close}`;
                    }
                    return match;
                }
            );
        }
    }

    // 서브타이틀 — 3단계 폴백 무조건 교체 (방향 B v3)
    if (hero.subtitle?.ko && hero.subtitle?.en) {
        const bind = langBind(hero.subtitle.ko, hero.subtitle.en);
        if (bind) {
            let replaced = false;
            // 패턴 1: className에 vx-subtitle이 있는 p 태그
            result = result.replace(
                /(<p[^>]*className[^>]*vx-subtitle[^>]*>)([\s\S]*?)(<\/p>)/,
                (match, open, content, close) => {
                    replaced = true;
                    return `${open}${bind}${close}`;
                }
            );
            // 패턴 2: data-vp-id="hero-subtitle"
            if (!replaced) {
                result = result.replace(
                    /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="hero-subtitle"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
                    (match, open, content, close) => {
                        replaced = true;
                        return `${open}${bind}${close}`;
                    }
                );
            }
            // 패턴 3: h1 태그 이후 첫 번째 <p> 태그
            if (!replaced) {
                const h1Idx = result.indexOf('</h1>');
                if (h1Idx !== -1) {
                    const afterH1 = result.substring(h1Idx);
                    const pMatch = afterH1.match(/(<p[^>]*>)([\s\S]*?)(<\/p>)/);
                    if (pMatch) {
                        const fullMatch = pMatch[0];
                        const newP = `${pMatch[1]}${bind}${pMatch[3]}`;
                        result = result.substring(0, h1Idx) + afterH1.replace(fullMatch, newP);
                        replaced = true;
                    }
                }
            }
        }
    }

    // Hero stats 수치 교체
    if (hero.stats && Array.isArray(hero.stats)) {
        hero.stats.forEach((stat, i) => {
            // data-vp-id="hero-stat-num-{i}" 가 있는 태그의 내용 교체
            if (stat.number) {
                const escapedNum = stat.number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // data-vp-id 방식
                const vpPattern = new RegExp(
                    `(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="hero-stat-num-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`
                );
                result = result.replace(vpPattern, (match, open, content, close) => {
                    return `${open}${stat.number}${close}`;
                });
            }
            if (stat.label?.ko && stat.label?.en) {
                const bind = langBind(stat.label.ko, stat.label.en);
                if (bind) {
                    const vpPattern = new RegExp(
                        `(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="hero-stat-lbl-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`
                    );
                    result = result.replace(vpPattern, (match, open, content, close) => {
                        if (content.includes("lang==='ko'")) return match;
                        return `${open}${bind}${close}`;
                    });
                }
            }
        });
    }

    return result;
}

// ───── Features 텍스트 교체 ─────
function replaceFeatureText(code, json, langBind) {
    const feat = json.features;
    if (!feat) return code;
    let result = code;

    // 섹션 타이틀
    if (feat.title?.ko && feat.title?.en) {
        const bind = langBind(feat.title.ko, feat.title.en);
        if (bind) {
            result = result.replace(
                /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="feat-title"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
                (match, open, content, close) => {
                    if (content.includes("lang==='ko'")) return match;
                    return `${open}${bind}${close}`;
                }
            );
        }
    }

    // 섹션 서브타이틀
    if (feat.subtitle?.ko && feat.subtitle?.en) {
        const bind = langBind(feat.subtitle.ko, feat.subtitle.en);
        if (bind) {
            result = result.replace(
                /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="feat-subtitle"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
                (match, open, content, close) => {
                    if (content.includes("lang==='ko'")) return match;
                    return `${open}${bind}${close}`;
                }
            );
        }
    }

    // 각 feature 아이템
    if (feat.items && Array.isArray(feat.items)) {
        feat.items.forEach((item, i) => {
            // 태그
            if (item.tag?.ko && item.tag?.en) {
                const bind = langBind(item.tag.ko, item.tag.en);
                if (bind) {
                    result = result.replace(
                        new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="feat-tag-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                        (match, open, content, close) => {
                            if (content.includes("lang==='ko'")) return match;
                            return `${open}${bind}${close}`;
                        }
                    );
                }
            }
            // 타이틀
            if (item.title?.ko && item.title?.en) {
                const bind = langBind(item.title.ko, item.title.en);
                if (bind) {
                    result = result.replace(
                        new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="feat-item-title-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                        (match, open, content, close) => {
                            if (content.includes("lang==='ko'")) return match;
                            return `${open}${bind}${close}`;
                        }
                    );
                }
            }
            // 설명
            if (item.desc?.ko && item.desc?.en) {
                const bind = langBind(item.desc.ko, item.desc.en);
                if (bind) {
                    result = result.replace(
                        new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="feat-item-desc-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                        (match, open, content, close) => {
                            if (content.includes("lang==='ko'")) return match;
                            return `${open}${bind}${close}`;
                        }
                    );
                }
            }
        });
    }

    return result;
}

// ───── Stats 텍스트 교체 (C-6 가짜 수치 해결) ─────
function replaceStatsText(code, json, langBind) {
    const stats = json.stats;
    if (!stats) return code;
    let result = code;

    // 섹션 타이틀
    if (stats.title?.ko && stats.title?.en) {
        const bind = langBind(stats.title.ko, stats.title.en);
        if (bind) {
            result = result.replace(
                /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="stat-title"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
                (match, open, content, close) => {
                    if (content.includes("lang==='ko'")) return match;
                    return `${open}${bind}${close}`;
                }
            );
        }
    }

    // 각 stat 아이템 (수치 + 라벨 + 설명)
    if (stats.items && Array.isArray(stats.items)) {
        stats.items.forEach((item, i) => {
            // 수치 (가장 중요 — C-6 해결)
            if (item.number) {
                result = result.replace(
                    new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="stat-num-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                    (match, open, content, close) => {
                        return `${open}${item.number}${close}`;
                    }
                );
            }
            // 라벨
            if (item.label?.ko && item.label?.en) {
                const bind = langBind(item.label.ko, item.label.en);
                if (bind) {
                    result = result.replace(
                        new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="stat-lbl-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                        (match, open, content, close) => {
                            if (content.includes("lang==='ko'")) return match;
                            return `${open}${bind}${close}`;
                        }
                    );
                }
            }
            // 설명
            if (item.desc?.ko && item.desc?.en) {
                const bind = langBind(item.desc.ko, item.desc.en);
                if (bind) {
                    result = result.replace(
                        new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="stat-desc-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                        (match, open, content, close) => {
                            if (content.includes("lang==='ko'")) return match;
                            return `${open}${bind}${close}`;
                        }
                    );
                }
            }
        });
    }

    return result;
}

// ───── Pricing 텍스트 교체 (C-2 가격 미반영 해결) ─────
function replacePricingText(code, json, langBind) {
    const pricing = json.pricing;
    if (!pricing?.plans) return code;
    let result = code;

    pricing.plans.forEach((plan, i) => {
        // 플랜명
        if (plan.name?.ko && plan.name?.en) {
            const bind = langBind(plan.name.ko, plan.name.en);
            if (bind) {
                result = result.replace(
                    new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="price-name-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                    (match, open, content, close) => {
                        if (content.includes("lang==='ko'")) return match;
                        return `${open}${bind}${close}`;
                    }
                );
            }
        }

        // 가격 (C-2 핵심)
        if (plan.price) {
            result = result.replace(
                new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="price-val-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                (match, open, content, close) => {
                    return `${open}${plan.price}${close}`;
                }
            );
        }

        // CTA 버튼
        if (plan.cta?.ko && plan.cta?.en) {
            const bind = langBind(plan.cta.ko, plan.cta.en);
            if (bind) {
                result = result.replace(
                    new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="price-cta-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                    (match, open, content, close) => {
                        if (content.includes("lang==='ko'")) return match;
                        return `${open}${bind}${close}`;
                    }
                );
            }
        }
    });

    return result;
}

// ───── FAQ 텍스트 교체 ─────
function replaceFAQText(code, json, langBind) {
    const faq = json.faq;
    if (!faq?.items) return code;
    let result = code;

    faq.items.forEach((item, i) => {
        // 질문
        if (item.q?.ko && item.q?.en) {
            const bind = langBind(item.q.ko, item.q.en);
            if (bind) {
                result = result.replace(
                    new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="faq-q-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                    (match, open, content, close) => {
                        if (content.includes("lang==='ko'")) return match;
                        return `${open}${bind}${close}`;
                    }
                );
            }
        }
        // 답변
        if (item.a?.ko && item.a?.en) {
            const bind = langBind(item.a.ko, item.a.en);
            if (bind) {
                result = result.replace(
                    new RegExp(`(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="faq-a-${i}"[^>]*>)([\\s\\S]*?)(</[a-zA-Z][a-zA-Z0-9]*>)`),
                    (match, open, content, close) => {
                        if (content.includes("lang==='ko'")) return match;
                        return `${open}${bind}${close}`;
                    }
                );
            }
        }
    });

    return result;
}

// ───── CTA 텍스트 교체 ─────
function replaceCTAText(code, json, langBind) {
    let result = code;
    const brandName = json.navbar?.logo || 'App';

    // CTA 타이틀
    result = result.replace(
        /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="cta-title"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
        (match, open, content, close) => {
            if (content.includes("lang==='ko'")) return match;
            return `${open}{lang==='ko'?'지금 바로 시작하세요':'Get Started Today'}${close}`;
        }
    );

    // CTA 설명
    result = result.replace(
        /(<[a-zA-Z][a-zA-Z0-9]*[^>]*data-vp-id="cta-desc"[^>]*>)([\s\S]*?)(<\/[a-zA-Z][a-zA-Z0-9]*>)/,
        (match, open, content, close) => {
            if (content.includes("lang==='ko'")) return match;
            const safeB = brandName.replace(/'/g, "\\'");
            return `${open}{lang==='ko'?'${safeB}와 함께 아이디어를 현실로 만들어 보세요.':'Turn your idea into reality with ${safeB}.'}${close}`;
        }
    );

    return result;
}

// ─────────────────────────────────────────────────────────────
// 9-D. elementStyles 후처리 (사용자 색상 변경 적용)
// 비주얼 에디터에서 우클릭으로 변경한 색상을 컴포넌트 코드에 inline style로 주입
// ─────────────────────────────────────────────────────────────
function applyElementStyles(componentCode, elementStyles) {
    if (!componentCode || !elementStyles || typeof elementStyles !== 'object') {
        return componentCode;
    }
    const ids = Object.keys(elementStyles);
    if (ids.length === 0) return componentCode;

    let result = componentCode;

    for (const id of ids) {
        const styleObj = elementStyles[id] || {};
        const colorVal = styleObj.color;
        const bgVal = styleObj.bg;
        if (!colorVal && !bgVal) continue;

        // inline style 문자열 생성
        const styleParts = [];
        if (colorVal) styleParts.push(`color:'${colorVal}'`);
        if (bgVal) styleParts.push(`backgroundColor:'${bgVal}'`);
        const inlineStyle = `style={{${styleParts.join(',')}}}`;

        // data-vp-id="해당ID"가 있는 JSX 태그를 찾아 style 속성 주입
        // 패턴: data-vp-id="hero-title"
        // 동작: 해당 태그에 style이 이미 있으면 무시, 없으면 추가
        const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = new RegExp(`(data-vp-id="${escapedId}")(?![^<]*style=)`, 'g');
        result = result.replace(pattern, `$1 ${inlineStyle}`);
    }

    return result;
}

// ─────────────────────────────────────────────────────────────
// 9. 템플릿 조립
// ─────────────────────────────────────────────────────────────
function buildNavbar(d) {
    if (!d) d = {};
if (!d.links_i18n) d.links_i18n = (d.links || []).map(l => ({ en: l, ko: l }));
if (d.links_i18n.length === 0) d.links_i18n = [{ ko: '기능', en: 'Features', anchor: 'features' }, { ko: '가격', en: 'Pricing', anchor: 'pricing' }, { ko: '후기', en: 'Reviews', anchor: 'stats' }, { ko: 'FAQ', en: 'FAQ', anchor: 'faq' }];
if (!d.btn_secondary) d.btn_secondary = { ko: '로그인', en: 'Login' };
if (!d.btn_primary) d.btn_primary = { ko: '무료 시작', en: 'Get Started' };
if (!d.logo) d.logo = 'App';
    const links = d.links_i18n.map((l, i) => {
        const href = l.anchor ? `#${l.anchor}` : '#features';
        return `\n            <li><a href="${href}" data-vp-id="nav-link-${i}">{lang==='ko'?'${l.ko}':'${l.en}'}</a></li>`;
    }).join('');
    return `"use client";
import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('${process.env.SUPABASE_URL}', '${process.env.SUPABASE_ANON_KEY}', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vx-auth-token' }
});

export default function Navbar() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUser(data.user));
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.href = '/';
  };

  return (
    <nav className="vx-nav">
      <div className="vx-nav-inner">
        <a href="/" className="vx-nav-logo" data-vp-id="nav-logo">${d.logo}</a>
        <ul className="vx-nav-links">${links}
        </ul>
        <div style={{display:'flex',gap:'12px'}}>
          {user ? (
            <>
              <a href="/dashboard" className="vx-btn-secondary">대시보드</a>
              <button onClick={handleLogout} className="vx-btn-primary" style={{cursor:'pointer'}}>로그아웃</button>
            </>
          ) : (
            <>
              <a href="/auth" className="vx-btn-secondary" data-vp-id="nav-btn-sec">{lang==='ko'?'${d.btn_secondary.ko}':'${d.btn_secondary.en}'}</a>
              <a href="/auth" className="vx-btn-primary" data-vp-id="nav-btn-pri">{lang==='ko'?'${d.btn_primary.ko}':'${d.btn_primary.en}'}</a>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}`;
}

function buildHero(d, style = {}) {
    if (!d) d = {};
    if (!d.stats) d.stats = [];
    if (!d.label) d.label = { ko: '', en: '' };
    if (!d.title) d.title = { ko: 'Welcome', en: 'Welcome' };
    if (!d.subtitle) d.subtitle = { ko: '', en: '' };
    if (!d.btn_primary) d.btn_primary = { ko: '시작하기', en: 'Get Started' };
    if (!d.btn_secondary) d.btn_secondary = { ko: '데모 보기', en: 'View Demo' };
    const primaryColor = style.primaryColor || '#FF2D20';
    const safe = (str) => (str || '').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/\r/g, '').trim();
    const stats = d.stats.map((s, i) => `
          <div>
            <div data-vp-id="hero-stat-num-${i}" style={{fontSize:'1.8rem',fontWeight:900,color:'${primaryColor}'}}>${safe(s.number)}</div>
            <div data-vp-id="hero-stat-lbl-${i}" style={{fontSize:'0.85rem',color:'#aaa'}}>{lang==='ko'?'${s.label.ko.replace(/'/g, "\\'")}':'${s.label.en.replace(/'/g, "\\'")}'}</div>
          </div>`).join('');
    return `"use client";
import React from 'react';
import { Play } from 'lucide-react';

export default function HeroSection() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="hero" className="vx-hero">
      <img className="vx-hero-bg" src="https://picsum.photos/seed/citystreet999/1200/600" alt="hero" />
      <div className="vx-hero-content">
        <span className="vx-label" data-vp-id="hero-label">{lang==='ko'?'${d.label.ko.replace(/'/g, "\\'")}':'${d.label.en.replace(/'/g, "\\'")}'}</span>
        <h1 className="vx-title" data-vp-id="hero-title">{lang==='ko'?'${d.title.ko.replace(/'/g, "\\'")}':'${d.title.en.replace(/'/g, "\\'")}'}</h1>
        <p className="vx-subtitle" data-vp-id="hero-subtitle">{lang==='ko'?'${d.subtitle.ko.replace(/'/g, "\\'")}':'${d.subtitle.en.replace(/'/g, "\\'")}'}</p>
        <div style={{display:'flex',gap:'16px',marginTop:'32px',flexWrap:'wrap'}}>
          <a href="/auth" className="vx-btn-primary" data-vp-id="hero-btn-pri"><Play size={16}/>{lang==='ko'?'${d.btn_primary.ko.replace(/'/g, "\\'")}':'${d.btn_primary.en.replace(/'/g, "\\'")}'}</a>
          <a href="/dashboard" className="vx-btn-secondary" data-vp-id="hero-btn-sec">{lang==='ko'?'${d.btn_secondary.ko.replace(/'/g, "\\'")}':'${d.btn_secondary.en.replace(/'/g, "\\'")}'}</a>
        </div>
        <div style={{display:'flex',gap:'40px',marginTop:'48px',flexWrap:'wrap'}}>${stats}
        </div>
      </div>
    </section>
  );
}`;
}

function buildFeatures(d) {
    if (!d) d = {};
    if (!d.items) d.items = [];
    if (!d.label) d.label = { ko: '핵심 기능', en: 'Features' };
    if (!d.title) d.title = { ko: '기능', en: 'Features' };
    if (!d.subtitle) d.subtitle = { ko: '', en: '' };
    const safe = (str) => (str || '').replace(/'/g, "\\'").replace(/\n/g, ' ').replace(/\r/g, '').trim();
    const items = d.items.map((item, i) => `
        <div className="vx-card">
          <div className="vx-img">
            <img src="${item.customImage || `https://picsum.photos/seed/${safe(item.image_seed)}${i * 137}/800/500`}" alt="${safe(item.title.en)}" />
          </div>
          <div className="vx-card-body">
            <span className="vx-label" data-vp-id="feat-tag-${i}">{lang==='ko'?'${safe(item.tag.ko)}':'${safe(item.tag.en)}'}</span>
            <div className="vx-card-title" data-vp-id="feat-item-title-${i}">{lang==='ko'?'${safe(item.title.ko)}':'${safe(item.title.en)}'}</div>
            <div className="vx-card-desc" data-vp-id="feat-item-desc-${i}">{lang==='ko'?'${safe(item.desc.ko)}':'${safe(item.desc.en)}'}</div>
          </div>
        </div>`).join('');
    return `"use client";
import React from 'react';

export default function FeatureSection() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="features" style={{backgroundColor:'#0f0f0f',padding:'48px 0 40px'}}>
      <div className="vx-section" style={{paddingBottom:'0'}}>
        <span className="vx-label" data-vp-id="feat-label">{lang==='ko'?'${safe(d.label.ko)}':'${safe(d.label.en)}'}</span>
        <h2 className="vx-section-title" data-vp-id="feat-title">{lang==='ko'?'${safe(d.title.ko)}':'${safe(d.title.en)}'}</h2>
        <p data-vp-id="feat-subtitle" style={{color:'#999',marginBottom:'40px'}}>{lang==='ko'?'${safe(d.subtitle.ko)}':'${safe(d.subtitle.en)}'}</p>
        <div className="vx-grid-3">${items}
        </div>
      </div>
    </section>
  );
}`;
}

function buildStats(d, style = {}) {
    if (!d) d = {};
    if (!d.items) d.items = [];
    if (!d.label) d.label = { ko: '성과 지표', en: 'Performance' };
    if (!d.title) d.title = { ko: '성과', en: 'Results' };
    if (!d.subtitle) d.subtitle = { ko: '', en: '' };
    const primaryColor = style.primaryColor || '#FF2D20';
    const items = d.items.map((item, i) => `
        <div className="vx-stat-card">
          <div data-vp-id="stat-num-${i}" style={{fontSize:'2.5rem',fontWeight:900,color:'${primaryColor}',marginBottom:'8px'}}>${item.number}</div>
          <div data-vp-id="stat-lbl-${i}" style={{fontSize:'1.1rem',fontWeight:700,color:'#f1f1f1',marginBottom:'6px'}}>{lang==='ko'?'${item.label.ko}':'${item.label.en}'}</div>
          <div data-vp-id="stat-desc-${i}" style={{fontSize:'0.85rem',color:'#888'}}>{lang==='ko'?'${item.desc.ko}':'${item.desc.en}'}</div>
        </div>`).join('');
    return `"use client";
import React from 'react';

export default function StatsSection() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="stats" style={{backgroundColor:'#111',padding:'72px 0 40px'}}>
      <div className="vx-section" style={{paddingBottom:'0'}}>
        <span className="vx-label" data-vp-id="stat-label">{lang==='ko'?'${d.label.ko}':'${d.label.en}'}</span>
        <h2 className="vx-section-title" data-vp-id="stat-title">{lang==='ko'?'${d.title.ko}':'${d.title.en}'}</h2>
        <p data-vp-id="stat-subtitle" style={{color:'#999',marginBottom:'40px'}}>{lang==='ko'?'${d.subtitle.ko}':'${d.subtitle.en}'}</p>
        <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(200px,1fr))',gap:'24px'}}>${items}
        </div>
      </div>
    </section>
  );
}`;
}

function buildPricing(d, style = {}) {
    if (!d) d = {};
    if (!d.plans) d.plans = [];
    const primaryColor = style.primaryColor || '#FF2D20';
    const plans = d.plans.map((plan, i) => {
        const featKo = (plan.features.ko || plan.features || []).map((f, j) => `
              <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'10px'}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${primaryColor}" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span data-vp-id="price-feat-${i}-${j}" style={{color:'#ccc',fontSize:'0.9rem'}}>${f}</span>
              </div>`).join('');
        const featEn = (plan.features.en || plan.features || []).map((f, j) => `
              <div style={{display:'flex',alignItems:'center',gap:'10px',marginBottom:'10px'}}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="${primaryColor}" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                <span data-vp-id="price-feat-${i}-${j}" style={{color:'#ccc',fontSize:'0.9rem'}}>${f}</span>
              </div>`).join('');
        const bg = plan.highlight ? `rgba(${parseInt(primaryColor.slice(1,3),16)},${parseInt(primaryColor.slice(3,5),16)},${parseInt(primaryColor.slice(5,7),16)},0.08)` : '#1a1a1a';
        const border = plan.highlight ? primaryColor : '#2a2a2a';
        const nameKo = (plan.name.ko || plan.name || '').replace(/'/g, "\\'");
        const nameEn = (plan.name.en || plan.name || '').replace(/'/g, "\\'");
        const periodKo = (plan.period.ko || plan.period || '').replace(/'/g, "\\'");
        const periodEn = (plan.period.en || plan.period || '').replace(/'/g, "\\'");
        const ctaKo = (plan.cta.ko || plan.cta || '').replace(/'/g, "\\'");
        const ctaEn = (plan.cta.en || plan.cta || '').replace(/'/g, "\\'");
        return `
          <div className="vx-price-card" style={{background:'${bg}',border:'2px solid ${border}',borderRadius:'16px',padding:'32px',display:'flex',flexDirection:'column',justifyContent:'space-between',position:'relative',flex:'1',minWidth:'240px',maxWidth:'380px'}}>
            ${plan.highlight ? `<div style={{position:'absolute',top:'-12px',left:'50%',transform:'translateX(-50%)',background:'${primaryColor}',color:'#fff',fontSize:'0.75rem',fontWeight:700,padding:'4px 16px',borderRadius:'20px',letterSpacing:'1px',textTransform:'uppercase'}}>{lang==='ko'?'추천':'Best'}</div>` : ''}
            <div>
              <h3 data-vp-id="price-name-${i}" style={{fontSize:'1.3rem',fontWeight:800,color:'#fff',marginBottom:'8px'}}>{lang==='ko'?'${nameKo}':'${nameEn}'}</h3>
              <div style={{marginBottom:'20px'}}>
                <span data-vp-id="price-val-${i}" style={{fontSize:'2.5rem',fontWeight:900,color:'#fff'}}>${plan.price}</span>
                <span style={{fontSize:'0.9rem',color:'#888',marginLeft:'4px'}}>{lang==='ko'?'${periodKo}':'${periodEn}'}</span>
              </div>
              <div style={{marginBottom:'24px'}}>
                {lang==='ko'?<>${featKo}</>:<>${featEn}</>}
              </div>
            </div>
            <a href="/auth" data-vp-id="price-cta-${i}" className="${plan.highlight ? 'vx-btn-primary' : 'vx-btn-secondary'}" style={{width:'100%',justifyContent:'center',textAlign:'center',marginTop:'16px'}}>{lang==='ko'?'${ctaKo}':'${ctaEn}'}</a>
          </div>`;
    }).join('');
    return `"use client";
import React from 'react';

export default function PricingSection() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="pricing" style={{backgroundColor:'#0f0f0f',padding:'72px 0'}}>
      <div className="vx-section">
        <div style={{textAlign:'center',marginBottom:'48px'}}>
          <span className="vx-label">{lang==='ko'?'가격 플랜':'Pricing'}</span>
          <h2 style={{fontSize:'2rem',fontWeight:900,color:'#fff',marginTop:'8px'}}>{lang==='ko'?'나에게 맞는 플랜 선택':'Choose Your Plan'}</h2>
          <p style={{color:'#888',marginTop:'12px',fontSize:'1rem'}}>{lang==='ko'?'부담 없이 시작하고, 성장에 맞춰 업그레이드하세요':'Start free and scale as you grow'}</p>
        </div>
        <div style={{display:'flex',gap:'24px',justifyContent:'center',flexWrap:'wrap',alignItems:'stretch'}}>
          ${plans}
        </div>
      </div>
    </section>
  );
}`;
}
function buildFAQ(d, style = {}) {
    if (!d) d = {};
    if (!d.items) d.items = [];
    const primaryColor = style.primaryColor || '#FF2D20';
    const items = d.items.map((item, i) => {
        const qKo = (item.q.ko || item.q || '').replace(/'/g, "\\'");
        const qEn = (item.q.en || item.q || '').replace(/'/g, "\\'");
        const aKo = (item.a.ko || item.a || '').replace(/'/g, "\\'");
        const aEn = (item.a.en || item.a || '').replace(/'/g, "\\'");
        return `
          <div key={${i}} style={{borderBottom:'1px solid #2a2a2a'}}>
            <button onClick={() => setOpen(open === ${i} ? -1 : ${i})} style={{width:'100%',display:'flex',justifyContent:'space-between',alignItems:'center',padding:'20px 0',background:'transparent',border:'none',cursor:'pointer',textAlign:'left'}}>
              <span data-vp-id="faq-q-${i}" style={{color:open===${i}?'${primaryColor}':'#f1f1f1',fontSize:'1rem',fontWeight:600,paddingRight:'16px',transition:'color 0.2s ease'}}>{lang==='ko'?'${qKo}':'${qEn}'}</span>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="${primaryColor}" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{flexShrink:0,transition:'transform 0.2s',transform:open===${i}?'rotate(180deg)':'rotate(0deg)'}}><polyline points="6 9 12 15 18 9"/></svg>
            </button>
            {open === ${i} && (
              <div data-vp-id="faq-a-${i}" style={{padding:'0 0 20px 0',color:'#999',fontSize:'0.95rem',lineHeight:'1.7'}}>
                {lang==='ko'?'${aKo}':'${aEn}'}
              </div>
            )}
          </div>`;
    }).join('');
    return `"use client";
import React, { useState } from 'react';

export default function FAQSection() {
  const [open, setOpen] = useState(-1);
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="faq" style={{backgroundColor:'#111',padding:'72px 0'}}>
      <div className="vx-section">
        <div style={{textAlign:'center',marginBottom:'48px'}}>
          <span className="vx-label">FAQ</span>
          <h2 style={{fontSize:'2rem',fontWeight:900,color:'#fff',marginTop:'8px'}}>{lang==='ko'?'자주 묻는 질문':'Frequently Asked Questions'}</h2>
        </div>
        <div style={{maxWidth:'720px',margin:'0 auto'}}>
          ${items}
        </div>
      </div>
    </section>
  );
}`;
}
function buildCTA(json, style = {}) {
    if (!json) json = {};
    const primaryColor = style.primaryColor || '#FF2D20';
    const brandName = json.navbar?.logo || 'Validatix App';
    return `"use client";
import React from 'react';
import { ArrowRight } from 'lucide-react';

export default function CTASection() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <section id="cta" style={{padding:'72px 24px',background:'linear-gradient(135deg, ${primaryColor}15 0%, #0f0f0f 50%, ${primaryColor}10 100%)'}}>
      <div style={{maxWidth:'800px',margin:'0 auto',textAlign:'center'}}>
        <h2 data-vp-id="cta-title" style={{fontSize:'2.5rem',fontWeight:900,color:'#fff',marginBottom:'16px'}}>{lang==='ko'?'지금 바로 시작하세요':'Get Started Today'}</h2>
        <p data-vp-id="cta-desc" style={{color:'#999',fontSize:'1.05rem',lineHeight:'1.7',marginBottom:'32px'}}>{lang==='ko'?'${brandName}와 함께 아이디어를 현실로 만들어 보세요.':'Turn your idea into reality with ${brandName}.'}</p>
        <div style={{display:'flex',gap:'16px',justifyContent:'center',flexWrap:'wrap'}}>
          <a href="/auth" className="vx-btn-primary" data-vp-id="cta-btn"><ArrowRight size={16}/>{lang==='ko'?'무료로 시작하기':'Start for Free'}</a>
        </div>
      </div>
    </section>
  );
}`;
}

// ─────────────────────────────────────────────────────────────
// 9-A. AI 생성 컴포넌트 사전 검증 (D안 1단계)
// ─────────────────────────────────────────────────────────────
function validateComponentCode(code, componentName) {
    const errors = [];

    if (!code || typeof code !== 'string' || code.trim().length < 50) {
        return { valid: false, errors: ['코드가 비었거나 너무 짧음'] };
    }

    const ALLOWED_ICONS = new Set([
        'Play','Zap','Shield','Brain','BarChart2','Globe','Lock','Mail',
        'GitBranch','X','Link','Check','Star','ArrowRight','Plus','Trash2',
        'LogOut','BookOpen','Calendar','CheckSquare','TrendingUp','Clock',
        'Activity','Target','Award','Bookmark','List'
    ]);

    const FORBIDDEN_PATTERNS = [
        { pattern: /from\s+['"]next\/image['"]/, msg: 'next/image import 금지' },
        { pattern: /from\s+['"]next\/navigation['"]/, msg: 'next/navigation import 금지' },
        { pattern: /from\s+['"]next\/link['"]/, msg: 'next/link import 금지' },
        { pattern: /localStorage\./, msg: 'localStorage 사용 금지' },
        { pattern: /sessionStorage\./, msg: 'sessionStorage 사용 금지' },
        { pattern: /\bfetch\s*\(/, msg: 'fetch 호출 금지' },
        { pattern: /<form[\s>]/i, msg: 'form 태그 금지' }
    ];

    const firstNonEmptyLine = code.split('\n').find(l => l.trim().length > 0) || '';
    if (!firstNonEmptyLine.includes('"use client"') && !firstNonEmptyLine.includes("'use client'")) {
        errors.push('첫 줄이 "use client" 선언이 아님');
    }

    if (!/import\s+React\b/.test(code)) {
        errors.push('import React 누락');
    }

    if (!/export\s+default\s+function/.test(code)) {
        errors.push('export default function 누락');
    }

    // useState/useEffect 사용 시 import 체크
    if (/\buseState\b/.test(code) && !/import\s*\{[^}]*useState[^}]*\}\s*from\s*['"]react['"]/.test(code) && !/import\s+React[,\s]/.test(code)) {
        errors.push('useState 사용하지만 import 누락');
    }
    if (/\buseEffect\b/.test(code) && !/import\s*\{[^}]*useEffect[^}]*\}\s*from\s*['"]react['"]/.test(code) && !/import\s+React[,\s]/.test(code)) {
        errors.push('useEffect 사용하지만 import 누락');
    }

    // lang 변수 사용 시 선언 체크
    if (/\blang\s*===/.test(code) && !/const\s+lang\s*=/.test(code)) {
        errors.push('lang 변수 사용하지만 선언 누락');
    }

    const lucideMatch = code.match(/from\s+['"]lucide-react['"]/);
    if (lucideMatch) {
        const importMatch = code.match(/import\s*\{([^}]+)\}\s*from\s*['"]lucide-react['"]/);
        if (importMatch) {
            const importedIcons = importMatch[1].split(',').map(s => s.trim()).filter(Boolean);
            for (const icon of importedIcons) {
                if (!ALLOWED_ICONS.has(icon)) {
                    errors.push(`허용되지 않은 lucide-react 아이콘: ${icon}`);
                }
            }
        }
    }

    const externalImportRegex = /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g;
    let importMatch;
    while ((importMatch = externalImportRegex.exec(code)) !== null) {
        const pkg = importMatch[1];
        const allowed = pkg === 'react' || pkg === 'lucide-react' || pkg.startsWith('./') || pkg.startsWith('../') || pkg.startsWith('@/components/ui/');
        if (!allowed) {
            errors.push(`허용되지 않은 외부 import: ${pkg}`);
        }
        // ShadCN 설치된 컴포넌트만 허용
        if (pkg.startsWith('@/components/ui/')) {
            const INSTALLED_UI = ['card','button','badge','accordion','separator','tabs','input','label'];
            const uiName = pkg.replace('@/components/ui/', '');
            if (!INSTALLED_UI.includes(uiName)) {
                errors.push(`미설치 ShadCN 컴포넌트: ${uiName} (설치된 것: ${INSTALLED_UI.join(', ')})`);
            }
        }
    }

    for (const { pattern, msg } of FORBIDDEN_PATTERNS) {
        if (pattern.test(code)) {
            errors.push(msg);
        }
    }

    // ───── JSX 구문 검증 (@babel/parser AST 방식) ─────
    try {
        babelParse(code, {
            sourceType: 'module',
            plugins: ['jsx', 'typescript'],
            errorRecovery: false,
        });
    } catch (parseError) {
        const msg = parseError.message || 'JSX 구문 오류';
        const loc = parseError.loc ? ` (line ${parseError.loc.line}, col ${parseError.loc.column})` : '';
        errors.push(`JSX 구문 오류${loc}: ${msg.split('\n')[0]}`);
        if (parseError.loc && parseError.loc.line) {
            const _lines = code.split('\n');
            const _ln = parseError.loc.line;
            const _start = Math.max(0, _ln - 3);
            const _snippet = _lines.slice(_start, _ln + 2)
                .map((l, i) => `${_start + i + 1}| ${l}`).join('\n');
            console.log(`[JSX진단] ${componentName} 깨진 코드 (line ${_ln} 주변):\n${_snippet}`);
        }
    }

    return { valid: errors.length === 0, errors };
}

// ─────────────────────────────────────────────────────────────
// 9-B. 검증 실패 시 컴포넌트 자동 재생성 (D안 2단계)
// ─────────────────────────────────────────────────────────────
async function regenerateComponent(originalCode, validationErrors, sectionType, style, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Validatix] ✨ ${sectionType} 디자인 최적화 중...` : `[Validatix] ✨ ${sectionType} optimizing design...`);
    const primaryColor = (style && style.primaryColor) || '#FF2D20';
    const errorList = validationErrors.map(e => `- ${e}`).join('\n');

    const prompt = `You are a senior React engineer. Fix the following Next.js component that failed validation.

[VALIDATION ERRORS]:
${errorList}

[ORIGINAL CODE]:
${originalCode.substring(0, 3000)}

[SECTION TYPE]: ${sectionType}
[PRIMARY COLOR]: ${primaryColor}

[STRICT RULES]:
1. First line MUST be: "use client";
2. MUST include: import React from 'react';
3. ONLY these lucide-react icons allowed: Play, Zap, Shield, Brain, BarChart2, Globe, Lock, Mail, GitBranch, X, Link, Check, Star, ArrowRight, Plus, Trash2, LogOut, BookOpen, Calendar, CheckSquare, TrendingUp, Clock, Activity, Target, Award, Bookmark, List
4. NO external imports except: react, lucide-react, @/components/ui/*
5. NO next/image, NO next/navigation, NO next/link
6. NO localStorage, NO sessionStorage, NO fetch(), NO <form> tag
7. Images: <img src="https://picsum.photos/seed/WORD/800/500" alt="x" /> ONLY
8. MUST end with: export default function ComponentName() { ... }
9. Close ALL JSX tags properly
10. Output RAW CODE ONLY. No markdown, no triple backticks, no explanation.
11. ShadCN ALLOWED: You may import from "@/components/ui/": Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter (from "card"), Button (from "button"), Badge (from "badge"), Accordion, AccordionItem, AccordionTrigger, AccordionContent (from "accordion"), Separator (from "separator"), Tabs, TabsList, TabsTrigger, TabsContent (from "tabs"), Input (from "input"), Label (from "label").
12. DARK THEME: NEVER use white or light backgrounds. Card backgrounds must be dark (#1a1a1a to #222).

Output the complete fixed component code:`;

    try {
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 4096,
            messages: [{ role: 'user', content: prompt }]
        });
        let fixedCode = result.content[0].text.trim()
            .replace(/^```[a-zA-Z]*\n?/gm, '')
            .replace(/```$/gm, '')
            .trim();
        return fixedCode;
    } catch (err) {
        sendLog(isKo ? `[Validatix] 🔄 ${sectionType} 대체 디자인 적용 중...` : `[Validatix] 🔄 ${sectionType} applying alternate design...`);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────
// 9-C. AI 컴포넌트 코드 직접 생성 (D안 핵심)
// ─────────────────────────────────────────────────────────────
async function generateSectionComponents(contentJson, style, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    const primaryColor = (style && style.primaryColor) || '#FF2D20';
    const bgColor = (style && style.bgColor) || '#0f0f0f';

    // 결과 컴포넌트 저장 객체. 각 키별로 코드 또는 null(실패) 저장
    const result = {
        HeroSection: null,
        FeatureSection: null,
        StatsSection: null,
        PricingSection: null,
        FAQSection: null,
        CTASection: null
    };

    // 공통 디자인 가이드라인 (1회차/2회차 프롬프트 모두 사용)
    const DESIGN_GUIDE = `
[DESIGN PHILOSOPHY]
You are a world-class SaaS UI designer at the level of Linear, Vercel, Stripe, Lovable.
Generate VARIED, MODERN, PRODUCTION-QUALITY components.
Each generation should look DIFFERENT from a typical AI output.

[DESIGN PRINCIPLES]
- Generous whitespace and breathing room (padding 60-100px)
- Asymmetric layouts when appropriate (not always centered)
- Bold typography hierarchy (font-weight 900 for hero, 700 for sections)
- Subtle gradients (linear, radial, or mesh)
- Micro-interactions via inline styles (hover transforms, transitions)
- Modern card styles: glass morphism, subtle borders with gradient, layered shadows
- Use primaryColor (${primaryColor}) for accents, gradients, and highlights
- Background uses bgColor (${bgColor}) as base

[VARIATION REQUIREMENTS & MINIMUM QUALITY STANDARDS]
- Hero: MUST use split layout (text left + image/card right) or image background. MUST highlight part of the title text with primaryColor. MUST include stats (4 numbers) below CTA buttons. MUST include 2 CTA buttons. Vary gradient direction, image placement, stats card style.
- Features: MUST include image on top (full width) + icon + description text below. Card text area background MUST be #2a2a2a to #333. Card border should use subtle border or primaryColor accent. NEVER overlay text on images. NEVER use light/white/yellow backgrounds (#fff, #ffffff, #f5f5f5, #fafafa, white, #eee, #e5e5e5, #fef, #ffe, yellow). Vary card layout (image-top, zigzag, bento grid).
- Stats: MUST include icon + progress bar or badge or color-coded accent for each stat. NEVER plain numbers only. If the content data contains service promises/specs (e.g. "24/7", "3min", "99.9%") instead of user metrics, render them as service highlights, not achievement stats. Vary structure (big numbers with bars, circular badges, comparison bars).
- Pricing: MUST visually highlight the recommended plan (border, scale, gradient). MUST include CTA button per plan. CTA button MUST have marginTop: 16px or more to separate from feature list. Vary highlight style (center-tall, badge-corner, gradient-border).
- FAQ: MUST use working accordion with useState. MUST have at least 4 Q&A pairs. Vary disclosure style (chevron, plus-minus, sliding panel).
- CTA: MUST use gradient or pattern background. MUST be simple: one heading, one paragraph, 1-2 buttons only. No complex layouts.

[TECHNICAL CONSTRAINTS - VIOLATING ANY = FAILURE]
1. First line MUST be: "use client";
2. MUST include: import React from 'react';
3. ONLY lucide-react icons from this list: Play, Zap, Shield, Brain, BarChart2, Globe, Lock, Mail, GitBranch, X, Link, Check, Star, ArrowRight, Plus, Trash2, LogOut, BookOpen, Calendar, CheckSquare, TrendingUp, Clock, Activity, Target, Award, Bookmark, List
4. NO external imports except react and lucide-react
5. NO next/image, NO next/navigation, NO next/link, NO Image from anywhere
6. NO localStorage, NO sessionStorage, NO fetch(), NO <form> tag (FAQ button is OK)
7. Images: ONLY <img src="https://picsum.photos/seed/WORD/800/500" alt="x" />
8. Use vx-* CSS classes when available: vx-section, vx-grid-3, vx-grid-2, vx-card, vx-card-body, vx-card-title, vx-card-desc, vx-img, vx-btn-primary, vx-btn-secondary, vx-title, vx-subtitle, vx-section-title, vx-label
9. Inline styles AND Tailwind utility classes are allowed and encouraged for variation
10. Close ALL JSX tags. Use TypeScript-safe syntax.
11. Detect language: const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
12. Render bilingual content as: {lang==='ko'?'한국어':'English'}
13. Output RAW CODE ONLY. No markdown fences, no explanations.
14. MUST end with valid: export default function ComponentName() { ... return ( ... ); }
15. DARK THEME CONSISTENCY: Your component runs inside a page with background #0f0f0f and text #f1f1f1. NEVER use white or light backgrounds (no #fff, #ffffff, #f5f5f5, #fafafa, white, #eee, #e5e5e5). Card backgrounds must be dark (#1a1a1a to #222). Text must be light (#f1f1f1, #ccc, #999, #888). This is NOT optional.
16. CONTENT DATA BINDING: You MUST render the EXACT text from the provided content data (hero.title.ko, features.items[i].title.ko, etc). Do NOT invent new text, descriptions, or numbers. The content data is the single source of truth.
17. IMAGE SEEDS: Use ONLY the image_seed values from contentJson (e.g. features.items[i].image_seed). Format: https://picsum.photos/seed/{image_seed}{index}/800/500. Do NOT use random or unrelated seed words.
18. SECTION ID: Each section MUST have an id attribute on the outermost element. HeroSection: id="hero", FeatureSection: id="features", StatsSection: id="stats", PricingSection: id="pricing", FAQSection: id="faq", CTASection: id="cta". This enables navbar anchor links.
19. SHADCN COMPONENTS: You MAY use ShadCN components for UI structure. Available imports from "@/components/ui/": Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter (from "card"), Button (from "button"), Badge (from "badge"), Accordion, AccordionItem, AccordionTrigger, AccordionContent (from "accordion"), Separator (from "separator"), Tabs, TabsList, TabsTrigger, TabsContent (from "tabs"), Input (from "input"), Label (from "label"). Import example: import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card". Use these instead of raw div-based cards. You may combine ShadCN components with inline styles and Tailwind classes for variation.
20. MOBILE RESPONSIVE: All text MUST use word-break: keep-all for Korean text. Hero title MUST use fontSize: clamp(1.8rem, 5vw, 3.5rem). All containers MUST use padding: 0 24px minimum. Grid layouts MUST collapse to single column on mobile (use Tailwind: grid-cols-1 md:grid-cols-2 lg:grid-cols-3 or inline media query). NEVER use fixed width values that exceed 100vw. All images MUST use width: 100% and max-width: 100%.
`;

    // ───── 1회차: Hero + Feature + Stats ─────
    sendLog(isKo ? `[Claude] 🎨 컴포넌트 생성 1회차 (Hero + Feature + Stats)...` : `[Claude] 🎨 Generating Round 1 (Hero + Feature + Stats)...`);

    const round1Prompt = `
[DESIGN PHILOSOPHY]
You are a world-class SaaS UI designer at the level of Linear, Vercel, Stripe, Lovable.
Generate VARIED, MODERN, PRODUCTION-QUALITY components.

[DESIGN PRINCIPLES]
- Generous whitespace and breathing room (padding 60-100px)
- Asymmetric layouts when appropriate (not always centered)
- Bold typography hierarchy (font-weight 900 for hero, 700 for sections)
- Subtle gradients (linear, radial, or mesh)
- Micro-interactions via inline styles (hover transforms, transitions)
- Modern card styles: glass morphism, subtle borders with gradient, layered shadows
- Use primaryColor (${primaryColor}) for accents, gradients, and highlights
- Background uses bgColor (${bgColor}) as base

[VARIATION REQUIREMENTS - THIS ROUND ONLY]
- Hero: MUST use split layout (text left + image/card right) or image background. MUST highlight part of the title text with primaryColor. MUST include stats (4 numbers) below CTA buttons. MUST include 2 CTA buttons. Vary gradient direction, image placement, stats card style.
- Features: MUST include image on top (full width) + icon + description text below. Card text area background MUST be #2a2a2a to #333. Card border should use subtle border or primaryColor accent. NEVER overlay text on images. NEVER use light/white/yellow backgrounds. Vary card layout (image-top, zigzag, bento grid).
- Stats: MUST include icon + progress bar or badge or color-coded accent for each stat. NEVER plain numbers only. Vary structure (big numbers with bars, circular badges, comparison bars).

[TECHNICAL CONSTRAINTS - VIOLATING ANY = INSTANT REJECTION]
1. First line MUST be: "use client";
2. MUST include: import React from 'react';
3. ONLY lucide-react icons: Play, Zap, Shield, Brain, BarChart2, Globe, Lock, Mail, GitBranch, X, Link, Check, Star, ArrowRight, Plus, Trash2, LogOut, BookOpen, Calendar, CheckSquare, TrendingUp, Clock, Activity, Target, Award, Bookmark, List
4. NO external imports except react and lucide-react
5. NO next/image, NO next/navigation, NO next/link, NO Image from anywhere
6. NO localStorage, NO sessionStorage, NO fetch(), NO <form> tag
7. Images: ONLY <img src="https://picsum.photos/seed/WORD/800/500" alt="x" />
8. Use vx-* CSS classes when available: vx-section, vx-grid-3, vx-grid-2, vx-card, vx-card-body, vx-card-title, vx-card-desc, vx-img, vx-btn-primary, vx-btn-secondary, vx-title, vx-subtitle, vx-section-title, vx-label
9. Inline styles AND Tailwind utility classes are allowed
10. Close ALL JSX tags. Use TypeScript-safe syntax.
11. Detect language: const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
12. Render bilingual content as: {lang==='ko'?'한국어':'English'}
13. Output RAW CODE ONLY. No markdown fences, no explanations.
14. MUST end with valid: export default function ComponentName() { ... return ( ... ); }
15. DARK THEME: NEVER use white or light backgrounds. Card backgrounds must be dark (#1a1a1a to #222). Text must be light (#f1f1f1, #ccc, #999, #888).
16. CONTENT DATA BINDING: Render the EXACT text from the provided content data. Do NOT invent new text.
17. IMAGE SEEDS: Use ONLY the image_seed values from contentJson.
18. SECTION ID: HeroSection: id="hero", FeatureSection: id="features", StatsSection: id="stats".
19. ShadCN: You MAY use from "@/components/ui/": card, button, badge, accordion, separator, tabs, input, label. These are the ONLY installed ones. Do NOT use dialog, sheet, select, dropdown-menu, or any others.
20. MOBILE RESPONSIVE: word-break: keep-all for Korean. Hero title: fontSize: clamp(1.8rem, 5vw, 3.5rem). Grid: collapse to single column on mobile.
21. NO NAVBAR: Do NOT include any <nav>, navigation bar, header bar, or top menu in your component. The Navbar is a SEPARATE component managed by the system. Including any navigation element will cause a duplicate navbar bug.

[PRE-VALIDATION CHECKLIST - YOUR CODE WILL BE PARSED BY @babel/parser IMMEDIATELY]
Before outputting each component, mentally verify:
✓ Every <tag> has a matching </tag> or is self-closing <tag />
✓ Every { has a matching }
✓ Every ( has a matching )
✓ useState/useEffect are imported if used
✓ lang variable is declared if used
✓ No imports except react, lucide-react, @/components/ui/*
✓ First line is "use client";
✓ Ends with export default function

[CONTENT DATA]:
hero = ${JSON.stringify(contentJson.hero, null, 2)}
features = ${JSON.stringify(contentJson.features, null, 2)}
stats = ${JSON.stringify(contentJson.stats, null, 2)}
style.primaryColor = "${primaryColor}"
style.bgColor = "${bgColor}"

[YOUR TASK]
Generate THREE separate Next.js client components: HeroSection, FeatureSection, StatsSection.
Output them in this EXACT format:

===HeroSection===
(complete code)
===FeatureSection===
(complete code)
===StatsSection===
(complete code)

[CRITICAL]
- Use === markers EXACTLY as shown
- Each component is COMPLETE and SELF-CONTAINED
- The VERY FIRST HTML element in return MUST have id attribute: HeroSection: id="hero", FeatureSection: id="features", StatsSection: id="stats"
- Output RAW CODE ONLY. Start IMMEDIATELY with ===HeroSection===`;

    try {
        const round1Result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 12000,
            messages: [{ role: 'user', content: round1Prompt }]
        });
        const round1Text = round1Result.content[0].text;
        const heroCode = extractSection(round1Text, 'HeroSection');
        const featureCode = extractSection(round1Text, 'FeatureSection');
        const statsCode = extractSection(round1Text, 'StatsSection');

        result.HeroSection = await validateOrRegenerate(heroCode, 'HeroSection', style, sendLog, lang);
        result.FeatureSection = await validateOrRegenerate(featureCode, 'FeatureSection', style, sendLog, lang);
        result.StatsSection = await validateOrRegenerate(statsCode, 'StatsSection', style, sendLog, lang);

        sendLog(isKo ? `[Claude] ✅ 1회차 완료 (Hero:${result.HeroSection?'OK':'FALLBACK'} / Feature:${result.FeatureSection?'OK':'FALLBACK'} / Stats:${result.StatsSection?'OK':'FALLBACK'})` : `[Claude] ✅ Round 1 done (Hero:${result.HeroSection?'OK':'FALLBACK'} / Feature:${result.FeatureSection?'OK':'FALLBACK'} / Stats:${result.StatsSection?'OK':'FALLBACK'})`);
    } catch (err) {
        sendLog(`⚠️ 1회차 API 오류: ${err.message} → 전체 폴백`);
    }

    // ───── 2회차: Pricing + FAQ + CTA ─────
    sendLog(isKo ? `[Claude] 🎨 컴포넌트 생성 2회차 (Pricing + FAQ + CTA)...` : `[Claude] 🎨 Generating Round 2 (Pricing + FAQ + CTA)...`);

    const brandName = (contentJson.navbar && contentJson.navbar.logo) || 'App';
    const round2Prompt = `
[DESIGN PHILOSOPHY]
You are a world-class SaaS UI designer at the level of Linear, Vercel, Stripe, Lovable.
Generate VARIED, MODERN, PRODUCTION-QUALITY components.

[DESIGN PRINCIPLES]
- Generous whitespace and breathing room (padding 60-100px)
- Bold typography hierarchy (font-weight 900 for hero, 700 for sections)
- Subtle gradients (linear, radial, or mesh)
- Use primaryColor (${primaryColor}) for accents, gradients, and highlights
- Background uses bgColor (${bgColor}) as base

[VARIATION REQUIREMENTS - THIS ROUND ONLY]
- Pricing: MUST visually highlight the recommended plan (border, scale, gradient). MUST include CTA button per plan. CTA button MUST have marginTop: 16px or more to separate from feature list. Vary highlight style (center-tall, badge-corner, gradient-border).
- FAQ: MUST use working accordion with useState. MUST have at least 4 Q&A pairs. Vary disclosure style (chevron, plus-minus, sliding panel).
- CTA: MUST use gradient or pattern background. MUST be simple: one heading, one paragraph, 1-2 buttons only. No complex layouts.

[TECHNICAL CONSTRAINTS - VIOLATING ANY = INSTANT REJECTION]
1. First line MUST be: "use client";
2. MUST include: import React from 'react';
3. ONLY lucide-react icons: Play, Zap, Shield, Brain, BarChart2, Globe, Lock, Mail, GitBranch, X, Link, Check, Star, ArrowRight, Plus, Trash2, LogOut, BookOpen, Calendar, CheckSquare, TrendingUp, Clock, Activity, Target, Award, Bookmark, List
4. NO external imports except react and lucide-react
5. NO next/image, NO next/navigation, NO next/link, NO Image from anywhere
6. NO localStorage, NO sessionStorage, NO fetch(), NO <form> tag (FAQ button is OK)
7. Images: ONLY <img src="https://picsum.photos/seed/WORD/800/500" alt="x" />
8. Use vx-* CSS classes when available
9. Close ALL JSX tags. Use TypeScript-safe syntax.
10. Detect language: const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
11. Render bilingual content as: {lang==='ko'?'한국어':'English'}
12. Output RAW CODE ONLY. No markdown fences, no explanations.
13. MUST end with valid: export default function ComponentName() { ... return ( ... ); }
14. DARK THEME: NEVER use white or light backgrounds. Card backgrounds must be dark (#1a1a1a to #222).
15. CONTENT DATA BINDING: Render the EXACT text from the provided content data. Do NOT invent new text.
16. SECTION ID: PricingSection: id="pricing", FAQSection: id="faq", CTASection: id="cta".
17. ShadCN: You MAY use from "@/components/ui/": card, button, badge, accordion, separator, tabs, input, label. These are the ONLY installed ones. Do NOT use dialog, sheet, select, dropdown-menu, or any others.
18. All CTA buttons linking to auth: <a href="/auth" className="vx-btn-primary"> or vx-btn-secondary
19. NO NAVBAR: Do NOT include any <nav>, navigation bar, header bar, or top menu in your component. The Navbar is a SEPARATE component managed by the system. Including any navigation element will cause a duplicate navbar bug.

[PRE-VALIDATION CHECKLIST - YOUR CODE WILL BE PARSED BY @babel/parser IMMEDIATELY]
Before outputting each component, mentally verify:
✓ Every <tag> has a matching </tag> or is self-closing <tag />
✓ Every { has a matching }
✓ Every ( has a matching )
✓ useState is imported if used (FAQ needs it)
✓ lang variable is declared if used
✓ No imports except react, lucide-react, @/components/ui/*
✓ First line is "use client";
✓ Ends with export default function

[CONTENT DATA]:
pricing = ${JSON.stringify(contentJson.pricing, null, 2)}
faq = ${JSON.stringify(contentJson.faq, null, 2)}
brandName = "${brandName}"
style.primaryColor = "${primaryColor}"
style.bgColor = "${bgColor}"

[YOUR TASK]
Generate THREE separate Next.js client components: PricingSection, FAQSection, CTASection.
Output them in this EXACT format:

===PricingSection===
(complete code)
===FAQSection===
(complete code)
===CTASection===
(complete code)

[CRITICAL]
- PricingSection: render pricing.plans array EXACTLY as provided. Use EXACT plan.name, plan.price, plan.period, plan.features[], plan.cta values. Do NOT invent new pricing text.
- FAQSection: render faq.items array EXACTLY. Use EXACT item.q and item.a text. Use useState for accordion.
- CTASection: simple structure only. One heading, one paragraph, 1-2 buttons. Link to /auth.
- The VERY FIRST HTML element in return MUST have id attribute: PricingSection: id="pricing", FAQSection: id="faq", CTASection: id="cta"
- Output RAW CODE ONLY. Start IMMEDIATELY with ===PricingSection===`;

    try {
        const round2Result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 12000,
            messages: [{ role: 'user', content: round2Prompt }]
        });
        const round2Text = round2Result.content[0].text;
        const pricingCode = extractSection(round2Text, 'PricingSection');
        const faqCode = extractSection(round2Text, 'FAQSection');
        const ctaCode = extractSection(round2Text, 'CTASection');

        result.PricingSection = await validateOrRegenerate(pricingCode, 'PricingSection', style, sendLog, lang);
        result.FAQSection = await validateOrRegenerate(faqCode, 'FAQSection', style, sendLog, lang);
        result.CTASection = await validateOrRegenerate(ctaCode, 'CTASection', style, sendLog, lang);

        sendLog(isKo ? `[Claude] ✅ 2회차 완료 (Pricing:${result.PricingSection?'OK':'FALLBACK'} / FAQ:${result.FAQSection?'OK':'FALLBACK'} / CTA:${result.CTASection?'OK':'FALLBACK'})` : `[Claude] ✅ Round 2 done (Pricing:${result.PricingSection?'OK':'FALLBACK'} / FAQ:${result.FAQSection?'OK':'FALLBACK'} / CTA:${result.CTASection?'OK':'FALLBACK'})`);
    } catch (err) {
        sendLog(`⚠️ 2회차 API 오류: ${err.message} → 전체 폴백`);
    }

    return result;
}

// ───── 3번 함수의 헬퍼 1: 섹션 추출 ─────
function extractSection(fullText, sectionName) {
    const startMarker = `===${sectionName}===`;
    const startIdx = fullText.indexOf(startMarker);
    if (startIdx === -1) return null;

    const afterStart = startIdx + startMarker.length;

    // 다음 "섹션 마커"만 찾는다: ===영문이름=== 형태.
    // 코드 속 비교연산자(lang === 'ko')는 === 뒤에 공백/따옴표가 오므로 걸리지 않음.
    const nextMarkerRegex = /===[A-Za-z][A-Za-z0-9]*===/g;
    nextMarkerRegex.lastIndex = afterStart;
    const nextMatch = nextMarkerRegex.exec(fullText);
    const sectionEnd = nextMatch ? nextMatch.index : fullText.length;

    let sectionCode = fullText.substring(afterStart, sectionEnd).trim();

    // 마크다운 코드 펜스 제거
    sectionCode = sectionCode
        .replace(/^```[a-zA-Z]*\n?/gm, '')
        .replace(/```\s*$/gm, '')
        .trim();

    return sectionCode || null;
}

// ───── 3번 함수의 헬퍼 2: 검증 + 재생성 통합 ─────
async function validateOrRegenerate(code, sectionName, style, sendLog, lang = 'ko') {
    const isKo = lang === 'ko';
    if (!code) {
        sendLog(`⚠️ ${sectionName} 코드 추출 실패 → 폴백 예정`);
        return null;
    }

    const validation1 = validateComponentCode(code, sectionName);
    if (validation1.valid) {
        return code;
    }

    console.log(`[FALLBACK진단] ${sectionName} 1차 검증 실패:`, JSON.stringify(validation1.errors));
    sendLog(isKo ? `[Validatix] 🎨 ${sectionName} 스타일 다듬기...` : `[Validatix] 🎨 ${sectionName} refining styles...`);
    const regenerated = await regenerateComponent(code, validation1.errors, sectionName, style, sendLog, lang);
    if (!regenerated) {
        sendLog(isKo ? `[Validatix] 🎨 ${sectionName} 폴백 준비 중...` : `[Validatix] 🎨 ${sectionName} preparing fallback...`);
        return null;
    }

    const validation2 = validateComponentCode(regenerated, sectionName);
    if (validation2.valid) {
        sendLog(isKo ? `[Validatix] ✅ ${sectionName} 최적화 완료` : `[Validatix] ✅ ${sectionName} optimized`);
        return regenerated;
    }

    console.log(`[FALLBACK진단] ${sectionName} 2차 검증 실패:`, JSON.stringify(validation2.errors));
    sendLog(isKo ? `[Validatix] 🎨 ${sectionName} 안정 디자인 적용` : `[Validatix] 🎨 ${sectionName} applying stable design`);
    return null;
}

function buildWatermark() {
    return `"use client";
import React from 'react';

export default function Watermark() {
  return (
    <div style={{position:'fixed',bottom:'16px',right:'16px',zIndex:9999,background:'rgba(0,0,0,0.7)',backdropFilter:'blur(8px)',border:'1px solid rgba(255,255,255,0.1)',borderRadius:'20px',padding:'6px 12px',display:'flex',alignItems:'center',gap:'6px'}}>
      <span style={{fontSize:'11px',color:'#999',fontWeight:600}}>Built with</span>
      <span style={{fontSize:'11px',color:'#FF2D20',fontWeight:900,letterSpacing:'-0.3px'}}>Validatix</span>
    </div>
  );
}`;
}

function buildLegalPage(type, brandName, idea, prd) {
    const titles = {
        privacy: { ko: '개인정보처리방침', en: 'Privacy Policy' },
        terms: { ko: '이용약관', en: 'Terms of Service' },
        cookies: { ko: '쿠키 정책', en: 'Cookie Policy' }
    };
    const title = titles[type] || titles.privacy;
    return `"use client";
import React from 'react';

export default function ${type === 'privacy' ? 'PrivacyPage' : type === 'terms' ? 'TermsPage' : 'CookiesPage'}() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',padding:'80px 24px 48px'}}>
      <div style={{maxWidth:'720px',margin:'0 auto'}}>
        <a href="/" style={{color:'#FF2D20',textDecoration:'none',fontSize:'0.9rem',fontWeight:600,marginBottom:'32px',display:'inline-block'}}>← {lang==='ko'?'홈으로':'Home'}</a>
        <h1 style={{fontSize:'2rem',fontWeight:900,color:'#fff',marginBottom:'12px'}}>{lang==='ko'?'${title.ko}':'${title.en}'}</h1>
        <p style={{color:'#666',fontSize:'0.85rem',marginBottom:'40px'}}>{lang==='ko'?'최종 수정일: ${new Date().toISOString().split('T')[0]}':'Last updated: ${new Date().toISOString().split('T')[0]}'}</p>
        <div style={{color:'#ccc',fontSize:'0.95rem',lineHeight:'1.8'}}>
          <p style={{marginBottom:'24px'}}>{lang==='ko'?'${brandName}(이하 "서비스")는 이용자의 개인정보를 중요시하며, 관련 법령을 준수합니다. 본 ${title.ko}는 서비스 이용 시 적용되는 정책을 안내합니다.':'${brandName} ("Service") values your privacy and complies with applicable laws. This ${title.en} describes the policies that apply when you use our Service.'}</p>
          <p style={{marginBottom:'24px'}}>{lang==='ko'?'본 문서는 AI에 의해 자동 생성되었으며, 법적 효력을 위해 전문가 검토를 권장합니다.':'This document was auto-generated by AI. Professional legal review is recommended for legal validity.'}</p>
          <div style={{background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'10px',padding:'20px',marginTop:'32px'}}>
            <p style={{color:'#FF2D20',fontSize:'0.85rem',fontWeight:700,marginBottom:'8px'}}>⚠️ {lang==='ko'?'안내':'Notice'}</p>
            <p style={{color:'#999',fontSize:'0.85rem',lineHeight:'1.6'}}>{lang==='ko'?'이 페이지는 Validatix Engine이 자동으로 생성한 템플릿입니다. 실제 서비스 운영 시에는 법률 전문가의 검토를 받으시기 바랍니다.':'This page is a template auto-generated by Validatix Engine. Please consult a legal professional before operating your service.'}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
`;
}

function buildFooter(d, year, style = {}) {
    if (!d) d = {};
    if (!d.columns) d.columns = [];
    if (d.columns.length === 0) d.columns = [{ title: { ko: '제품', en: 'Product' }, links: [{ ko: '기능', en: 'Features' }, { ko: '가격', en: 'Pricing' }, { ko: '업데이트', en: 'Changelog' }] }, { title: { ko: '회사', en: 'Company' }, links: [{ ko: '소개', en: 'About' }, { ko: '블로그', en: 'Blog' }, { ko: '채용', en: 'Careers' }] }, { title: { ko: '법적고지', en: 'Legal' }, links: [{ ko: '개인정보처리방침', en: 'Privacy' }, { ko: '이용약관', en: 'Terms' }, { ko: '쿠키 정책', en: 'Cookies' }] }];
    if (!d.logo) d.logo = 'App';
    if (!d.tagline) d.tagline = { ko: '', en: '' };
    if (!d.copyright) d.copyright = 'App';
    if (!d.newsletter) d.newsletter = { title:{ko:'뉴스레터',en:'Newsletter'}, placeholder:{ko:'이메일',en:'Email'}, btn:{ko:'구독',en:'Subscribe'} };
    const primaryColor = style.primaryColor || '#FF2D20';
    const columns = d.columns.map((col, ci) => {
        const FOOTER_ANCHOR_MAP = {'features':'#features','기능':'#features','pricing':'#pricing','가격':'#pricing','changelog':'#stats','업데이트':'#stats','about':'#hero','소개':'#hero','blog':'#hero','블로그':'#hero','careers':'#hero','채용':'#hero','privacy':'/privacy','개인정보처리방침':'/privacy','terms':'/terms','이용약관':'/terms','cookies':'/cookies','쿠키 정책':'/cookies'};
        const linkItems = col.links.map((l, li) => {
            const anchor = FOOTER_ANCHOR_MAP[l.en.toLowerCase()] || FOOTER_ANCHOR_MAP[l.ko] || '#';
            return `<div style={{marginBottom:'10px'}}><a href="${anchor}" data-vp-id="footer-link-${ci}-${li}" style={{color:'#777',textDecoration:'none'}}>{lang==='ko'?'${l.ko.replace(/'/g, "\\'")}':'${l.en.replace(/'/g, "\\'")}'}</a></div>`;
        }).join('\n            ');
        return `
          <div>
            <div style={{color:'${primaryColor}',fontWeight:700,fontSize:'0.75rem',letterSpacing:'2px',textTransform:'uppercase',marginBottom:'16px'}}>{lang==='ko'?'${col.title.ko.replace(/'/g, "\\'")}':'${col.title.en.replace(/'/g, "\\'")}'}</div>
            ${linkItems}
          </div>`;
    }).join('');
    return `"use client";
import React, { useState } from 'react';
import { GitBranch, X, Link, Mail } from 'lucide-react';

export default function Footer() {
  const lang = typeof navigator !== 'undefined' && navigator.language.startsWith('ko') ? 'ko' : 'en';
  const [email, setEmail] = useState('');
  return (
    <footer style={{backgroundColor:'#0a0a0a',borderTop:'1px solid #1a1a1a',padding:'48px 24px 32px',marginTop:'0'}}>
      <div style={{maxWidth:'1200px',margin:'0 auto'}}>
        <div style={{display:'grid',gridTemplateColumns:'2fr 1fr 1fr 1fr',gap:'48px',marginBottom:'48px'}}>
          <div>
            <div className="vx-nav-logo" data-vp-id="footer-logo" style={{marginBottom:'16px'}}>${d.logo}</div>
            <p data-vp-id="footer-tagline" style={{color:'#888',fontSize:'0.9rem',lineHeight:1.7,marginBottom:'24px'}}>{lang==='ko'?'${d.tagline.ko.replace(/'/g, "\\'")}':'${d.tagline.en.replace(/'/g, "\\'")}'}</p>
            <div style={{display:'flex',gap:'16px'}}>
              <GitBranch size={20} style={{color:'#888',cursor:'pointer'}}/>
              <X size={20} style={{color:'#888',cursor:'pointer'}}/>
              <Link size={20} style={{color:'#888',cursor:'pointer'}}/>
              <Mail size={20} style={{color:'#888',cursor:'pointer'}}/>
            </div>
          </div>
          ${columns}
          <div>
            <div style={{color:'${primaryColor}',fontWeight:700,fontSize:'0.75rem',letterSpacing:'2px',textTransform:'uppercase',marginBottom:'16px'}}>{lang==='ko'?'${d.newsletter.title.ko.replace(/'/g, "\\'")}':'${d.newsletter.title.en.replace(/'/g, "\\'")}'}</div>
            <div style={{display:'flex',gap:'8px'}}>
              <input value={email} onChange={e=>setEmail(e.target.value)}
                placeholder={lang==='ko'?'${d.newsletter.placeholder.ko.replace(/'/g, "\\'")}':'${d.newsletter.placeholder.en.replace(/'/g, "\\'")}'}
                style={{flex:1,background:'#1a1a1a',border:'1px solid #2a2a2a',borderRadius:'6px',padding:'10px 14px',color:'#f1f1f1',fontSize:'0.9rem'}}/>
              <button className="vx-btn-primary" style={{padding:'10px 20px',whiteSpace:'nowrap',flexShrink:0}}>{lang==='ko'?'${d.newsletter.btn.ko.replace(/'/g, "\\'")}':'${d.newsletter.btn.en.replace(/'/g, "\\'")}'}</button>
            </div>
          </div>
        </div>
        <hr className="vx-divider"/>
        <div style={{marginTop:'24px',color:'#555',fontSize:'0.85rem'}}>© ${year} <span data-vp-id="footer-copyright">${d.copyright}</span>. {lang==='ko'?'모든 권리 보유.':'All rights reserved.'}</div>
      </div>
    </footer>
  );
}`;
}

// ─────────────────────────────────────────────────────────────
// 외부 API 자동 탑재 (사용자 앱용) — 3단계
// ─────────────────────────────────────────────────────────────
function detectRequiredAPIs(prd) {
    const text = (prd || '').toLowerCase();
    const detected = [];
    const mapKeywords = ['지도','위치','배달','부동산','여행','주소','거리','매장','장소','경로','맛집','주차','택시','물류','배송','근처','가까운','동네','카페','레스토랑','map','location','delivery','restaurant','nearby','route','address','place','store','navigation'];
    const emailKeywords = ['이메일발송','예약확인메일','뉴스레터발송','메일링','초대메일','안내메일','통보메일','가입환영메일','email send','email notification','newsletter send','send email','transactional email'];
    const aiKeywords = ['챗봇','상담','추천','요약','분석','자동응답','고객지원','AI','chatbot','recommend','summary','analyze','support','assistant','generate','자동생성','번역','translate'];
    const imageKeywords = ['이미지','사진','갤러리','포트폴리오','업로드','썸네일','프로필사진','상품사진','리뷰사진','image','photo','gallery','upload','thumbnail','portfolio','avatar','picture'];
    const calendarKeywords = ['캘린더연동','구글캘린더','일정동기화','캘린더API','calendar sync','google calendar','calendar integration','calendar API','ical'];
    const minMatch = 3;
    if (mapKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('google_maps');
    if (emailKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('resend');
    if (aiKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('openai');
    if (imageKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('cloudinary');
    if (calendarKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('google_calendar');
    const analyticsKeywords = ['구글애널리틱스','GA연동','트래픽분석','방문자추적','페이지뷰추적','google analytics','GA4','analytics integration','traffic analytics','pageview tracking'];
    const smsKeywords = ['SMS','문자','인증번호','본인인증','휴대폰인증','전화번호인증','OTP','sms','verification','phone verify','text message','two-factor','2fa','인증코드','본인확인'];
    if (analyticsKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('google_analytics');
    if (smsKeywords.filter(k => text.includes(k)).length >= minMatch) detected.push('twilio');
    return detected;
}

function buildGoogleMapsPage() {
    return `"use client";
import React, { useEffect, useRef } from 'react';

export default function MapView() {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstance = useRef<any>(null);

  useEffect(() => {
    if (mapInstance.current) return;
    const script = document.createElement('script');
    script.src = \`https://maps.googleapis.com/maps/api/js?key=\${process.env.NEXT_PUBLIC_GOOGLE_MAPS_KEY}&callback=initMap\`;
    script.async = true;
    script.defer = true;
    (window as any).initMap = () => {
      if (mapRef.current) {
        mapInstance.current = new (window as any).google.maps.Map(mapRef.current, {
          center: { lat: 37.5665, lng: 126.978 },
          zoom: 13,
          styles: [
            { elementType: 'geometry', stylers: [{ color: '#1a1a1a' }] },
            { elementType: 'labels.text.fill', stylers: [{ color: '#999' }] },
            { elementType: 'labels.text.stroke', stylers: [{ color: '#0f0f0f' }] },
            { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#2a2a2a' }] },
            { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#0a0a2a' }] }
          ]
        });
      }
    };
    document.head.appendChild(script);
  }, []);

  return (
    <div style={{width:'100%',height:'400px',borderRadius:'12px',overflow:'hidden',border:'1px solid #2a2a2a',background:'#1a1a1a'}}>
      <div ref={mapRef} style={{width:'100%',height:'100%'}}/>
    </div>
  );
}
`;
}

function buildEmailAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { to, subject, html } = await req.json();
    if (!to || !subject) {
      return NextResponse.json({ error: 'to와 subject는 필수입니다.' }, { status: 400 });
    }
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${process.env.RESEND_API_KEY}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'noreply@' + (process.env.NEXT_PUBLIC_SITE_URL || 'example.com').replace('https://','').replace('http://',''),
        to,
        subject,
        html: html || '<p>내용이 없습니다.</p>',
      }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data }, { status: res.status });
    return NextResponse.json({ success: true, id: data.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

function buildOpenAIChatAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { message, systemPrompt } = await req.json();
    if (!message) {
      return NextResponse.json({ error: 'message는 필수입니다.' }, { status: 400 });
    }
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': \`Bearer \${process.env.OPENAI_API_KEY}\`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt || 'You are a helpful assistant.' },
          { role: 'user', content: message }
        ],
        max_tokens: 1024,
      }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data }, { status: res.status });
    return NextResponse.json({ reply: data.choices[0].message.content });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

function buildCloudinaryUploadAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file') as File;
    if (!file) {
      return NextResponse.json({ error: '파일이 없습니다.' }, { status: 400 });
    }
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET || 'ml_default';
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    uploadForm.append('upload_preset', uploadPreset);
    const res = await fetch(\`https://api.cloudinary.com/v1_1/\${cloudName}/image/upload\`, {
      method: 'POST',
      body: uploadForm,
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data }, { status: res.status });
    return NextResponse.json({ url: data.secure_url, public_id: data.public_id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

function buildGoogleCalendarAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { summary, description, startDateTime, endDateTime } = await req.json();
    if (!summary || !startDateTime || !endDateTime) {
      return NextResponse.json({ error: 'summary, startDateTime, endDateTime는 필수입니다.' }, { status: 400 });
    }
    const res = await fetch(\`https://www.googleapis.com/calendar/v3/calendars/primary/events?key=\${process.env.GOOGLE_CALENDAR_API_KEY}\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary,
        description: description || '',
        start: { dateTime: startDateTime, timeZone: 'Asia/Seoul' },
        end: { dateTime: endDateTime, timeZone: 'Asia/Seoul' },
      }),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data }, { status: res.status });
    return NextResponse.json({ success: true, eventId: data.id });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

// ─────────────────────────────────────────────────────────────
// Stripe 결제 자동 탑재 (사용자 앱용)
// ─────────────────────────────────────────────────────────────
function buildGoogleAnalyticsLayout() {
    return `import type { Metadata } from "next";
import "./globals.css";
import Script from "next/script";

export const metadata: Metadata = {
  title: "App",
  description: "Generated by Validatix Engine",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko" className="dark">
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Script
          strategy="afterInteractive"
          src={\`https://www.googletagmanager.com/gtag/js?id=\${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}\`}
        />
        <Script id="ga-script" strategy="afterInteractive">
          {\`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '\${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}');
          \`}
        </Script>
      </head>
      <body style={{ backgroundColor: '#0f0f0f', color: '#f1f1f1', minHeight: '100vh' }}>
        {children}
      </body>
    </html>
  );
}
`;
}

function buildTwilioSMSAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const { to, body } = await req.json();
    if (!to || !body) {
      return NextResponse.json({ error: 'to와 body는 필수입니다.' }, { status: 400 });
    }
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!accountSid || !authToken || !fromNumber) {
      return NextResponse.json({ error: 'Twilio 설정이 누락되었습니다.' }, { status: 500 });
    }
    const res = await fetch(\`https://api.twilio.com/2010-04-01/Accounts/\${accountSid}/Messages.json\`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + btoa(\`\${accountSid}:\${authToken}\`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        To: to,
        From: fromNumber,
        Body: body,
      }).toString(),
    });
    const data = await res.json();
    if (!res.ok) return NextResponse.json({ error: data.message || data }, { status: res.status });
    return NextResponse.json({ success: true, sid: data.sid });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}
function buildCheckoutAPI(userStripeKey) {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.USER_STRIPE_SECRET_KEY!, { apiVersion: '2024-12-18.acacia' });
    const { priceId, mode, successUrl, cancelUrl } = await req.json();
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: mode || 'payment',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl || \`\${process.env.NEXT_PUBLIC_SITE_URL || ''}/success?session_id={CHECKOUT_SESSION_ID}\`,
      cancel_url: cancelUrl || \`\${process.env.NEXT_PUBLIC_SITE_URL || ''}/\`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err: any) {
    console.error('Checkout error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

function buildWebhookAPI() {
    return `import { NextRequest, NextResponse } from 'next/server';

export async function POST(req: NextRequest) {
  try {
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.USER_STRIPE_SECRET_KEY!, { apiVersion: '2024-12-18.acacia' });
    const { createClient } = await import('@supabase/supabase-js');
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
    const body = await req.text();
    const sig = req.headers.get('stripe-signature')!;
    let event: any;
    try {
      event = stripe.webhooks.constructEvent(body, sig, process.env.USER_STRIPE_WEBHOOK_SECRET || '');
    } catch (err: any) {
      console.error('Webhook signature failed:', err.message);
      return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
    }

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.customer_email || session.customer_details?.email;
      if (email) {
        const { data: userData } = await supabase.from('auth.users').select('id').eq('email', email).single().catch(() => ({ data: null }));
        await supabase.from('payments').insert({
          user_id: userData?.id || null,
          email,
          stripe_session_id: session.id,
          amount: session.amount_total,
          currency: session.currency,
          status: 'completed',
        });
      }
    }

    return NextResponse.json({ received: true });
  } catch (err: any) {
    console.error('Webhook error:', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
`;
}

function buildSuccessPage() {
    return `"use client";
import React from 'react';
import { Check } from 'lucide-react';

export default function SuccessPage() {
  return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px'}}>
      <div style={{textAlign:'center',maxWidth:'480px'}}>
        <div style={{width:'64px',height:'64px',borderRadius:'50%',background:'#10b981',display:'flex',alignItems:'center',justifyContent:'center',margin:'0 auto 24px'}}>
          <Check size={32} color="#fff" />
        </div>
        <h1 style={{fontSize:'1.8rem',fontWeight:900,color:'#fff',marginBottom:'12px'}}>결제 완료!</h1>
        <p style={{color:'#999',fontSize:'1rem',lineHeight:1.7,marginBottom:'32px'}}>결제가 성공적으로 처리되었습니다. 감사합니다.</p>
        <a href="/dashboard" style={{display:'inline-flex',alignItems:'center',gap:'8px',background:'#FF2D20',color:'#fff',padding:'12px 28px',borderRadius:'6px',fontWeight:700,fontSize:'0.95rem',textDecoration:'none'}}>대시보드로 이동</a>
      </div>
    </div>
  );
}
`;
}

function buildPaymentsTableSQL() {
    return `DROP TABLE IF EXISTS payments CASCADE; CREATE TABLE payments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE, email text NOT NULL, stripe_session_id text, amount integer, currency text DEFAULT 'usd', status text DEFAULT 'pending', created_at timestamptz DEFAULT now()); ALTER TABLE payments ENABLE ROW LEVEL SECURITY; CREATE POLICY payments_user_policy ON payments FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);`;
}

function buildAuthPage(supabaseUrl, supabaseAnonKey) {
    return `"use client";
import { useState } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('${supabaseUrl}', '${supabaseAnonKey}', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vx-auth-token' }
});

export default function AuthPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage('가입 완료! 로그인해 주세요.');
        setMode('login');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        window.location.href = '/dashboard';
      }
    } catch (err: any) {
      setMessage(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px'}}>
      <div style={{width:'100%',maxWidth:'400px',background:'#1a1a1a',borderRadius:'16px',padding:'32px',border:'1px solid #2a2a2a'}}>
        <h1 style={{color:'#fff',fontWeight:900,fontSize:'1.5rem',marginBottom:'8px',textAlign:'center'}}>
          {mode === 'login' ? '로그인' : '회원가입'}
        </h1>
        <form onSubmit={handleAuth} style={{display:'flex',flexDirection:'column',gap:'16px',marginTop:'24px'}}>
          <input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="이메일" required
            style={{background:'#111',border:'1px solid #333',borderRadius:'8px',padding:'12px 16px',color:'#fff',fontSize:'14px'}}/>
          <input type="password" value={password} onChange={e=>setPassword(e.target.value)} placeholder="비밀번호 (6자 이상)" minLength={6} required
            style={{background:'#111',border:'1px solid #333',borderRadius:'8px',padding:'12px 16px',color:'#fff',fontSize:'14px'}}/>
          {message && <p style={{color: message.startsWith('가입') ? '#4ade80' : '#f87171',fontSize:'13px',textAlign:'center'}}>{message}</p>}
          <button type="submit" disabled={loading}
            style={{background:'#FF2D20',color:'#fff',border:'none',borderRadius:'8px',padding:'14px',fontWeight:700,fontSize:'15px',cursor:'pointer'}}>
            {loading ? '처리 중...' : mode === 'login' ? '로그인' : '회원가입'}
          </button>
        </form>
        <p style={{color:'#888',fontSize:'13px',textAlign:'center',marginTop:'16px',cursor:'pointer'}}
          onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setMessage(''); }}>
          {mode === 'login' ? '계정이 없으신가요? 회원가입' : '이미 계정이 있으신가요? 로그인'}
        </p>
      </div>
    </div>
  );
}
`;
}

async function buildComponents(json, sendLog, isPaidUser = false, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Validatix] 🔨 템플릿 조립 중...` : `[Validatix] 🔨 Assembling templates...`);
    const year = new Date().getFullYear();
    const style = json.style || {};

    // ───── 전체 JSON 방어 코드 (모든 build 함수 크래시 방지) ─────
    if (!json.navbar) json.navbar = {};
    if (!json.navbar.logo) json.navbar.logo = 'App';
    if (!json.navbar.links) json.navbar.links = [];
    if (!json.navbar.links_i18n) json.navbar.links_i18n = (json.navbar.links || []).map(l => ({ en: l, ko: l }));
    if (!json.navbar.btn_secondary) json.navbar.btn_secondary = { ko: '로그인', en: 'Login' };
    if (!json.navbar.btn_primary) json.navbar.btn_primary = { ko: '무료 시작', en: 'Get Started' };

    if (!json.hero) json.hero = {};
    if (!json.hero.label) json.hero.label = { ko: '', en: '' };
    if (!json.hero.title) json.hero.title = { ko: 'Welcome', en: 'Welcome' };
    if (!json.hero.subtitle) json.hero.subtitle = { ko: '', en: '' };
    if (!json.hero.btn_primary) json.hero.btn_primary = { ko: '시작하기', en: 'Get Started' };
    if (!json.hero.btn_secondary) json.hero.btn_secondary = { ko: '데모 보기', en: 'View Demo' };
    if (!json.hero.stats) json.hero.stats = [];

    if (!json.features) json.features = {};
    if (!json.features.label) json.features.label = { ko: '핵심 기능', en: 'Features' };
    if (!json.features.title) json.features.title = { ko: '기능', en: 'Features' };
    if (!json.features.subtitle) json.features.subtitle = { ko: '', en: '' };
    if (!json.features.items) json.features.items = [];

    if (!json.stats) json.stats = {};
    if (!json.stats.label) json.stats.label = { ko: '성과 지표', en: 'Performance' };
    if (!json.stats.title) json.stats.title = { ko: '성과', en: 'Results' };
    if (!json.stats.subtitle) json.stats.subtitle = { ko: '', en: '' };
    if (!json.stats.items) json.stats.items = [];

    if (!json.pricing) json.pricing = {};
    if (!json.pricing.plans) json.pricing.plans = [];

    if (!json.faq) json.faq = {};
    if (!json.faq.items) json.faq.items = [];

    if (!json.footer) json.footer = {};
    if (!json.footer.logo) json.footer.logo = json.navbar.logo || 'App';
    if (!json.footer.tagline) json.footer.tagline = { ko: '', en: '' };
    if (!json.footer.copyright) json.footer.copyright = json.navbar.logo || 'App';
    if (!json.footer.columns) json.footer.columns = [];
    if (!json.footer.newsletter) json.footer.newsletter = { title: { ko: '뉴스레터', en: 'Newsletter' }, placeholder: { ko: '이메일', en: 'Email' }, btn: { ko: '구독', en: 'Subscribe' } };

    // ───── D안: AI 컴포넌트 생성 시도 ─────
    let aiComponents = {
        HeroSection: null,
        FeatureSection: null,
        StatsSection: null,
        PricingSection: null,
        FAQSection: null,
        CTASection: null
    };

    try {
        aiComponents = await generateSectionComponents(json, style, sendLog, lang);
    } catch (err) {
        sendLog(`⚠️ AI 컴포넌트 생성 실패: ${err.message} → 전체 폴백`);
    }

    // ───── 폴백 매핑: AI 실패 시 기존 build 함수 사용 ─────
    const fallbackMap = {
        HeroSection:    () => buildHero(json.hero, style),
        FeatureSection: () => buildFeatures(json.features),
        StatsSection:   () => buildStats(json.stats, style),
        PricingSection: () => buildPricing(json.pricing, style),
        FAQSection:     () => buildFAQ(json.faq, style),
        CTASection:     () => buildCTA(json, style)
    };

    // 텍스트 정확도 보장 섹션은 폴백 강제 (방향 B v3)
    const FORCE_FALLBACK = new Set(['StatsSection', 'PricingSection', 'FAQSection', 'FeatureSection', 'CTASection']);
    console.log("[DEBUG] stats items:", json.stats?.items?.length, "pricing plans:", json.pricing?.plans?.length, "faq items:", json.faq?.items?.length, "features items:", json.features?.items?.length);

    const resolveComponent = (name) => {
        if (aiComponents[name] && !FORCE_FALLBACK.has(name)) {
            sendLog(isKo ? `[Validatix] ✨ ${name}: AI 코드 적용` : `[Validatix] ✨ ${name}: AI code applied`);
            let code = ensureSectionId(aiComponents[name], name);
            code = ensureCTALinks(code, name);
            code = injectVpIdsByText(code, json, name);
            // AI가 nav 태그를 포함한 경우 제거 (네비바 2중 렌더링 방지)
            code = code.replace(/<nav[\s\S]*?<\/nav>/gi, '');
            code = replaceTextWithContentJson(code, json, name);
            // customImage가 있는 features 항목은 AI 생성 코드에서도 Picsum URL을 커스텀 URL로 교체
            if (name === 'FeatureSection' && json.features?.items) {
                json.features.items.forEach((item, idx) => {
                    if (item.customImage) {
                        const picPattern = new RegExp(`https://picsum\\.photos/seed/[^"'\\s]+`, 'g');
                        let matchCount = 0;
                        code = code.replace(picPattern, (match) => {
                            if (matchCount === idx) { matchCount++; return item.customImage; }
                            matchCount++;
                            return match;
                        });
                    }
                });
            }
            return code;
        }
        sendLog(isKo ? `[Validatix] 🎨 ${name}: 기본 디자인 적용` : `[Validatix] 🎨 ${name}: fallback design applied`);
        return ensureSectionId(fallbackMap[name](), name);
    };

    // ───── 컴포넌트 배열 조립 ─────
    const components = [
        { path: 'components/Navbar.tsx',         code: buildNavbar(json.navbar) },
        { path: 'components/HeroSection.tsx',    code: resolveComponent('HeroSection') },
        { path: 'components/FeatureSection.tsx', code: resolveComponent('FeatureSection') },
        { path: 'components/StatsSection.tsx',   code: resolveComponent('StatsSection') },
        { path: 'components/Footer.tsx',         code: buildFooter(json.footer, year, style) },
        { path: 'components/PricingSection.tsx', code: resolveComponent('PricingSection') },
        { path: 'components/FAQSection.tsx',     code: resolveComponent('FAQSection') },
        { path: 'components/CTASection.tsx',     code: resolveComponent('CTASection') }
    ];

    if (!isPaidUser) {
        components.push({ path: 'components/Watermark.tsx', code: buildWatermark() });
    }

    // ───── elementStyles 후처리 (사용자 색상 변경 적용) ─────
    // 비주얼 에디터에서 우클릭으로 변경한 색상을 컴포넌트 코드에 주입
    const elementStyles = json.elementStyles || {};
    if (Object.keys(elementStyles).length > 0) {
        sendLog(isKo ? `[Validatix] 🎨 사용자 색상 적용 중 (${Object.keys(elementStyles).length}개)...` : `[Validatix] 🎨 Applying custom colors (${Object.keys(elementStyles).length} elements)...`);
        for (const comp of components) {
            comp.code = applyElementStyles(comp.code, elementStyles);
        }
        sendLog(isKo ? `[Validatix] ✅ 색상 적용 완료.` : `[Validatix] ✅ Colors applied.`);
    }

    return components;
}

async function generateMultiFileArchitecture(idea, prd, marketData, sendLog, isPaidUser = false, prebuiltJson = null, lang = 'ko') {
    const isKo = lang === 'ko';
    let json;
    const hasValidData = prebuiltJson && prebuiltJson.stats?.items?.length > 0 && prebuiltJson.pricing?.plans?.length > 0 && prebuiltJson.features?.items?.length > 0;
    if (hasValidData) {
        json = prebuiltJson;
    } else {
        json = await generateContentJSON(idea, sendLog, 'ko', prd);
        if (prebuiltJson) {
            if (prebuiltJson.style) json.style = prebuiltJson.style;
            if (prebuiltJson.sectionOrder) json.sectionOrder = prebuiltJson.sectionOrder;
            if (prebuiltJson.hiddenSections) json.hiddenSections = prebuiltJson.hiddenSections;
            if (prebuiltJson.elementStyles) json.elementStyles = prebuiltJson.elementStyles;
            if (prebuiltJson.userStripeKey) json.userStripeKey = prebuiltJson.userStripeKey;
            if (prebuiltJson.userAPIKeys) json.userAPIKeys = prebuiltJson.userAPIKeys;
        }
    }

    // ───── 재배포 시에도 가격 후처리 적용 ─────
    if (prebuiltJson && prd) {
        // 1순위: idea에서 가격 추출
        let dollarPrices = (idea.match(/\$\d+(?:\.\d{1,2})?/g) || []).map(p => p);
        let wonPrices = (idea.match(/₩[\d,]+|[\d,]+원/g) || []).map(p => {
            const num = p.replace(/[₩원,]/g, '');
            return `₩${Number(num).toLocaleString()}`;
        });
        // 2순위: idea에 가격이 없으면 PRD에서 "Pricing:" 문맥만 추출
        if (dollarPrices.length === 0 && wonPrices.length === 0) {
            const pricingMatch = prd.match(/[Pp]ricing[:\s]+\$\d+(?:\.\d{1,2})?/g) || [];
            const premiumMatch = prd.match(/\$\d+(?:\.\d{1,2})?\/month\s+(?:for\s+)?premium/gi) || [];
            const prdPriceMatches = [...pricingMatch, ...premiumMatch];
            dollarPrices = (prdPriceMatches.join(' ').match(/\$\d+(?:\.\d{1,2})?/g) || []);
            const prdWonMatches = prd.match(/[Pp]ricing[:\s]+(?:₩[\d,]+|[\d,]+원)/g) || [];
            wonPrices = (prdWonMatches.join(' ').match(/₩[\d,]+|[\d,]+원/g) || []).map(p => {
                const num = p.replace(/[₩원,]/g, '');
                return `₩${Number(num).toLocaleString()}`;
            });
        }
        const isKoPrice = (idea + prd).match(/[가-힣]/) !== null;
        const userPrices = isKoPrice ? [...wonPrices, ...dollarPrices] : dollarPrices;

        if (userPrices.length > 0 && json.pricing && json.pricing.plans) {
            const sorted = userPrices.length === 1
                ? [userPrices[0]]
                : userPrices.sort((a, b) => {
                    const numA = parseFloat(a.replace(/[^0-9.]/g, ''));
                    const numB = parseFloat(b.replace(/[^0-9.]/g, ''));
                    return numA - numB;
                });

            const plans = json.pricing.plans;
            if (sorted.length === 1) {
                const highlightIdx = plans.findIndex(p => p.highlight);
                if (highlightIdx !== -1) plans[highlightIdx].price = sorted[0];
                else if (plans.length >= 2) plans[1].price = sorted[0];
            } else {
                const paidPlans = plans.filter(p => {
                    const pp = typeof p.price === 'string' ? p.price : '';
                    return pp !== '$0' && pp !== '무료' && pp !== 'Free';
                });
                sorted.forEach((price, i) => {
                    if (i < paidPlans.length) paidPlans[i].price = price;
                });
            }
        }
    }
    sendLog(`[Claude] ✅ Content JSON ready.`);
    const files = await buildComponents(json, sendLog, isPaidUser, lang);
    const safePage = generateSafePage(files.map(f => f.path), json);
    files.push({ path: 'app/page.tsx', code: safePage });

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (supabaseUrl && supabaseAnonKey) {
        const supabaseClient = `import { createClient } from '@supabase/supabase-js';
export const supabase = createClient('${supabaseUrl}', '${supabaseAnonKey}', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vx-auth-token' }
});
`;
        files.push({ path: 'lib/supabase.ts', code: supabaseClient });
        sendLog(isKo ? `[Supabase] ✅ Supabase 클라이언트 생성 완료.` : `[Supabase] ✅ Supabase client ready.`);

        files.push({ path: 'app/auth/page.tsx', code: buildAuthPage(supabaseUrl, supabaseAnonKey) });
        sendLog(isKo ? `[Supabase] ✅ 로그인/회원가입 페이지 생성 완료.` : `[Supabase] ✅ Auth page ready.`);

        try {
            const schema = await generateDBSchema(idea, prd, sendLog, lang);
            const tableCreated = await createSupabaseTable(schema, sendLog, lang);

            if (!tableCreated) {
                sendLog(`⚠️ 테이블 생성 실패. 대시보드는 생성하지만 저장이 안 될 수 있습니다.`);
            }

            const featureSpec = await generateFeatureSpec(idea, prd, schema, sendLog, lang);
            const dashboardCode = buildDashboardPage(schema, featureSpec, supabaseUrl, supabaseAnonKey);
            files.push({ path: 'app/dashboard/page.tsx', code: dashboardCode });
            sendLog(isKo ? `[Validatix] ✅ 대시보드 + 위젯 + CRUD 생성 완료.` : `[Validatix] ✅ Dashboard + widgets + CRUD ready.`);
        } catch(e) {
            sendLog(`⚠️ DB 스키마 생성 실패: ${e.message}`);
        }
    }

    // ───── 외부 API 자동 탑재 (3단계) ─────
    const detectedAPIs = detectRequiredAPIs(prd);
    const userAPIKeys = json.userAPIKeys || {};
    if (detectedAPIs.length > 0) {
        sendLog(`[Validatix] 🔌 외부 API 감지: ${detectedAPIs.join(', ')}`);
        if (detectedAPIs.includes('google_maps') && userAPIKeys.googleMapsKey) {
            files.push({ path: 'components/MapView.tsx', code: buildGoogleMapsPage() });
            sendLog(`[API] ✅ Google Maps 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('resend') && userAPIKeys.resendKey) {
            files.push({ path: 'app/api/send-email/route.ts', code: buildEmailAPI() });
            sendLog(`[API] ✅ Resend 이메일 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('openai') && userAPIKeys.openaiKey) {
            files.push({ path: 'app/api/chat/route.ts', code: buildOpenAIChatAPI() });
            sendLog(`[API] ✅ OpenAI 챗봇 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('cloudinary') && userAPIKeys.cloudinaryName) {
            files.push({ path: 'app/api/upload/route.ts', code: buildCloudinaryUploadAPI() });
            sendLog(`[API] ✅ Cloudinary 이미지 업로드 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('google_calendar') && userAPIKeys.googleCalendarKey) {
            files.push({ path: 'app/api/calendar/route.ts', code: buildGoogleCalendarAPI() });
            sendLog(`[API] ✅ Google Calendar 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('google_analytics') && userAPIKeys.gaId) {
            // GA는 별도 파일이 아니라 layout.tsx를 교체하는 방식
            // layout.tsx에 GA 스크립트가 포함된 버전으로 덮어쓰기
            const gaLayoutCode = buildGoogleAnalyticsLayout();
            // 기존 layout.tsx를 찾아서 교체
            for (let i = 0; i < files.length; i++) {
                if (files[i].path === 'app/layout.tsx') {
                    // 기존 layout의 metadata를 보존하면서 GA 스크립트만 추가
                    const existingLayout = files[i].code;
                    const gaScript = `
        <Script
          strategy="afterInteractive"
          src={\`https://www.googletagmanager.com/gtag/js?id=\${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}\`}
        />
        <Script id="ga-script" strategy="afterInteractive">
          {\`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '\${process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID}');
          \`}
        </Script>`;
                    // head 태그 안에 GA 스크립트 삽입 + Script import 추가
                    files[i].code = existingLayout
                        .replace('import "./globals.css";', 'import "./globals.css";\nimport Script from "next/script";')
                        .replace('</head>', gaScript + '\n      </head>');
                    break;
                }
            }
            sendLog(`[API] ✅ Google Analytics 자동 탑재 완료.`);
        }
        if (detectedAPIs.includes('twilio') && userAPIKeys.twilioSid) {
            files.push({ path: 'app/api/sms/route.ts', code: buildTwilioSMSAPI() });
            sendLog(`[API] ✅ Twilio SMS 자동 탑재 완료.`);
        }
    }
    
    // ───── Stripe 결제 자동 탑재 (사용자 앱용) ─────
        const userStripeKey = json.userStripeKey || null;
        if (userStripeKey) {
            files.push({ path: 'app/api/checkout/route.ts', code: buildCheckoutAPI(userStripeKey) });
            files.push({ path: 'app/api/webhook/route.ts', code: buildWebhookAPI() });
            files.push({ path: 'app/success/page.tsx', code: buildSuccessPage() });
            sendLog(`[Stripe] ✅ 결제 시스템 자동 탑재 완료.`);

            // Checkout 페이지 자동 생성 (로그인 후 결제 진행)
            const checkoutPageCode = `"use client";
import React, { useState, useEffect } from 'react';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient('${supabaseUrl}', '${supabaseAnonKey}', {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'vx-auth-token' }
});

export default function CheckoutPage() {
  const [loading, setLoading] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) { window.location.href = '/auth'; return; }
      setUser(data.user);
    });
  }, []);

  const handleCheckout = async (priceId: string, mode: string) => {
    setLoading(true);
    try {
      const res = await fetch('/api/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceId, mode }),
      });
      const data = await res.json();
      if (data.url) window.location.href = data.url;
      else alert('결제 페이지를 열 수 없습니다.');
    } catch (err) {
      alert('결제 처리 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  if (!user) return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',display:'flex',alignItems:'center',justifyContent:'center'}}>
      <p style={{color:'#888'}}>로딩 중...</p>
    </div>
  );

  return (
    <div style={{minHeight:'100vh',background:'#0f0f0f',display:'flex',alignItems:'center',justifyContent:'center',padding:'24px'}}>
      <div style={{textAlign:'center',maxWidth:'480px'}}>
        <h1 style={{fontSize:'1.8rem',fontWeight:900,color:'#fff',marginBottom:'12px'}}>결제 진행</h1>
        <p style={{color:'#999',fontSize:'1rem',lineHeight:1.7,marginBottom:'32px'}}>Stripe 결제 페이지로 이동합니다.</p>
        <p style={{color:'#555',fontSize:'0.85rem'}}>결제는 Stripe 보안 결제 시스템을 통해 안전하게 처리됩니다.</p>
      </div>
    </div>
  );
}
`;
            files.push({ path: 'app/checkout/page.tsx', code: checkoutPageCode });

            // payments 테이블 자동 생성
            try {
                await pgPool.query(buildPaymentsTableSQL());
                sendLog(`[Supabase] ✅ 결제 테이블 생성 완료.`);
            } catch(e) {
                if (e.code === '42P07' || e.message.includes('already exists')) {
                    sendLog(`[Supabase] ✅ 결제 테이블 이미 존재.`);
                } else {
                    sendLog(`⚠️ 결제 테이블 생성 실패: ${e.message}`);
                }
            }
        }
    
    // ───── 법적 페이지 자동 생성 (15주차) ─────
    const legalBrandName = (json.navbar?.logo || 'App').replace(/'/g, "\\'");
    files.push({ path: 'app/privacy/page.tsx', code: buildLegalPage('privacy', legalBrandName, idea, prd) });
    files.push({ path: 'app/terms/page.tsx', code: buildLegalPage('terms', legalBrandName, idea, prd) });
    files.push({ path: 'app/cookies/page.tsx', code: buildLegalPage('cookies', legalBrandName, idea, prd) });
    sendLog(isKo ? `[Validatix] ✅ 법적 페이지 자동 생성 완료 (Privacy/Terms/Cookies).` : `[Validatix] ✅ Legal pages generated (Privacy/Terms/Cookies).`);
    
        sendLog(isKo ? `[Validatix] ✅ 컴포넌트 조립 완료.` : `[Validatix] ✅ Components assembled.`);
    return files;
}

// ─────────────────────────────────────────────────────────────
// 10. QA
// ─────────────────────────────────────────────────────────────
async function fixWithQA(buildLogs, currentFiles, sendLog, contentJson, style, lang = 'ko') {
    const isKo = lang === 'ko';
    sendLog(isKo ? `[Validatix] 🛠️ 디자인 점검 중...` : `[Validatix] 🛠️ Reviewing design...`);
    
    // 1단계: 에러 파일 정확히 특정 (tsc 에러 포맷 다중 파싱)
    const errorMatches = buildLogs.match(/(?:\.\/)?(?:components|app)\/[\w/]+\.tsx/g) || [];
    const uniqueErrors = [...new Set(errorMatches.map(f => f.replace('./', '')))];
    
    const filesToFix = uniqueErrors.length > 0
        ? currentFiles.filter(f => uniqueErrors.some(ef => f.path.includes(path.basename(ef))))
        : [];
    
    if (filesToFix.length === 0) return currentFiles;
    
    sendLog(isKo ? `[Validatix] ✨ 수정 중: ${filesToFix.map(f => path.basename(f.path)).join(', ')}` : `[Validatix] ✨ Fixing: ${filesToFix.map(f => path.basename(f.path)).join(', ')}`);
    
    // 폴백 매핑 (2회 실패 시 사용)
    const fallbackMap = {
        'HeroSection.tsx': () => buildHero(contentJson?.hero || {}, style || {}),
        'FeatureSection.tsx': () => buildFeatures(contentJson?.features || {}),
        'StatsSection.tsx': () => buildStats(contentJson?.stats || {}, style || {}),
        'PricingSection.tsx': () => buildPricing(contentJson?.pricing || {}, style || {}),
        'FAQSection.tsx': () => buildFAQ(contentJson?.faq || {}, style || {}),
        'CTASection.tsx': () => buildCTA(contentJson || {}, style || {}),
    };
    
    // 해당 파일의 에러 메시지만 정확히 추출
    const extractFileErrors = (fileName) => {
        const lines = buildLogs.split('\n');
        return lines.filter(l => l.includes(fileName)).join('\n').substring(0, 1500);
    };
    
    for (const targetFile of filesToFix) {
        const fileName = path.basename(targetFile.path);
        const fileErrors = extractFileErrors(fileName);
        
        // 2단계: 전체 코드 + 정확한 에러 메시지를 AI에게 전달
        const fixPrompt = `Fix this Next.js component. Output RAW CODE ONLY. No markdown.

[BUILD ERROR for ${fileName}]:
${fileErrors || buildLogs.substring(0, 1500)}

[FULL FILE - ${targetFile.path}]:
${targetFile.code}

[RULES]:
1. "use client"; first line.
2. ONLY lucide-react icons: Play, Zap, Shield, Brain, BarChart2, Globe, Lock, Mail, GitBranch, X, Link, Check, Star, ArrowRight, Plus, Trash2, LogOut, BookOpen, Calendar, CheckSquare, TrendingUp, Clock, Activity, Target, Award, Bookmark, List
3. Close ALL JSX tags. Raw code only. No markdown.
4. Default export = React component.
5. Images: <img src="https://picsum.photos/seed/WORD/800/500" alt="x" />
6. DARK THEME: NEVER use white or light backgrounds. Card backgrounds must be dark (#1a1a1a to #222).
7. ShadCN allowed: import from "@/components/ui/" (Card, Button, Badge, Accordion, etc).
8. NO next/image, NO next/navigation, NO next/link, NO localStorage, NO fetch(), NO <form>.
Output ONLY the fixed code:`;

        try {
            const msg = await anthropic.messages.create({
                model: MODEL_QA,
                max_tokens: 6000,
                messages: [{ role: "user", content: fixPrompt }]
            });
            let fixedCode = msg.content[0].text.replace(/^```[a-zA-Z]*\n/gm, '').replace(/```$/gm, '').trim();
            
            // 3단계: 수정된 코드를 @babel/parser로 즉시 검증
            const validation1 = validateComponentCode(fixedCode, fileName.replace('.tsx', ''));
            
            if (validation1.valid) {
                // 검증 통과 — 적용
                for (let i = 0; i < currentFiles.length; i++) {
                    if (currentFiles[i].path === targetFile.path) {
                        currentFiles[i].code = fixedCode;
                        sendLog(isKo ? `[Validatix] ✨ ${fileName} 수정 완료 (1차).` : `[Validatix] ✨ ${fileName} fixed (1st pass).`);
                        break;
                    }
                }
            } else {
                // 4단계: 1회 재시도
                sendLog(isKo ? `[Validatix] 🔄 ${fileName} 재시도 중... (${validation1.errors[0]})` : `[Validatix] 🔄 ${fileName} retrying... (${validation1.errors[0]})`);
                const retryMsg = await anthropic.messages.create({
                    model: MODEL_QA,
                    max_tokens: 6000,
                    messages: [
                        { role: "user", content: fixPrompt },
                        { role: "assistant", content: fixedCode },
                        { role: "user", content: `Validation failed: ${validation1.errors.join(', ')}. Fix these errors. Output ONLY raw code, no markdown.` }
                    ]
                });
                let retryCode = retryMsg.content[0].text.replace(/^```[a-zA-Z]*\n/gm, '').replace(/```$/gm, '').trim();
                
                const validation2 = validateComponentCode(retryCode, fileName.replace('.tsx', ''));
                
                if (validation2.valid) {
                    for (let i = 0; i < currentFiles.length; i++) {
                        if (currentFiles[i].path === targetFile.path) {
                            currentFiles[i].code = retryCode;
                            sendLog(isKo ? `[Validatix] ✨ ${fileName} 수정 완료 (2차).` : `[Validatix] ✨ ${fileName} fixed (2nd pass).`);
                            break;
                        }
                    }
                } else {
                    // 5단계: 2회 연속 실패 → 폴백 함수로 교체
                    const fallbackFn = fallbackMap[fileName];
                    if (fallbackFn && contentJson) {
                        const fallbackCode = fallbackFn();
                        for (let i = 0; i < currentFiles.length; i++) {
                            if (currentFiles[i].path === targetFile.path) {
                                currentFiles[i].code = ensureSectionId(fallbackCode, fileName.replace('.tsx', ''));
                                sendLog(isKo ? `[Validatix] 🎨 ${fileName} 기본 디자인 적용 (안정성).` : `[Validatix] 🎨 ${fileName} fallback applied (stability).`);
                                break;
                            }
                        }
                    } else {
                        sendLog(`⚠️ ${fileName} recovery failed. Keeping original.`);
                    }
                }
            }
        } catch (err) {
            sendLog(`⚠️ Design fix failed (${fileName}): ${err.message}`);
        }
    }
    return currentFiles;
}

// ─────────────────────────────────────────────────────────────
// 11. 파일 저장
// ─────────────────────────────────────────────────────────────
function writeFilesToDisk(filesToGenerate, projectPath, appDir, rootDir) {
    for (const file of filesToGenerate) {
        let relativePath = file.path.replace(/[*`]/g, '').trim();
        if (relativePath.startsWith('/')) relativePath = relativePath.substring(1);
        if (relativePath.startsWith('src/')) relativePath = relativePath.substring(4);
        let fullFilePath;
        if (relativePath.startsWith('lib/')) {
            fullFilePath = path.join(projectPath, relativePath);
        } else if (relativePath.startsWith('app/')) {
            fullFilePath = path.join(appDir, relativePath.substring(4));
        } else {
            fullFilePath = path.join(rootDir, relativePath);
        }
        const fileDir = path.dirname(fullFilePath);
        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
        fs.writeFileSync(fullFilePath, file.code);
    }
}

// ─────────────────────────────────────────────────────────────
// 12. 로컬 빌드 검증
// ─────────────────────────────────────────────────────────────
async function runPreBuildCheck(projectPath, currentFiles, sendLog, contentJson, style, lang = 'ko') {
    return new Promise((resolve) => {
        try {
            const npmCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
            const tscProcess = exec(`${npmCmd} tsc --noEmit --pretty false`, { cwd: projectPath, timeout: 30000 });
            let logs = '';
            tscProcess.stdout.on('data', (data) => { logs += data.toString(); });
            tscProcess.stderr.on('data', (data) => { logs += data.toString(); });
            tscProcess.on('close', async (code) => {
                if (code === 0) {
                    resolve({ needsFix: false, files: currentFiles });
                } else {
                    const isKo = lang === 'ko';
                    sendLog(isKo ? `[Validatix] 🔍 코드 사전 점검 중...` : `[Validatix] 🔍 Pre-build check...`);
                    const fixedFiles = await fixWithQA(logs, currentFiles, sendLog, contentJson, style, lang);
                    const appDir = path.join(projectPath, 'app');
                    const rootDir = fs.existsSync(path.join(projectPath, 'src')) ? path.join(projectPath, 'src') : projectPath;
                    writeFilesToDisk(fixedFiles, projectPath, appDir, rootDir);
                    resolve({ needsFix: true, files: fixedFiles });
                }
            });
            tscProcess.on('error', () => {
                resolve({ needsFix: false, files: currentFiles });
            });
        } catch(e) {
            resolve({ needsFix: false, files: currentFiles });
        }
    });
}

function runInstall(projectPath, sendLog, isKo = true) {
    return new Promise((resolve) => {
        sendLog(isKo ? `[Validatix] 📦 의존성 설치 중... (최초 1~2분 소요)` : `[Validatix] 📦 Installing dependencies...`);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const installProcess = exec(`${npmCmd} install --no-audit --no-fund`, { cwd: projectPath, timeout: 300000, maxBuffer: 1024 * 1024 * 10 });
        let logs = '';
        installProcess.stdout.on('data', (data) => { logs += data.toString(); });
        installProcess.stderr.on('data', (data) => { logs += data.toString(); });
        installProcess.on('close', (code) => {
            if (code === 0) {
                sendLog(isKo ? `[Validatix] ✅ 의존성 설치 완료.` : `[Validatix] ✅ Dependencies installed.`);
                resolve({ success: true, logs });
            } else {
                const errorLines = logs.split('\n').filter(l => l.trim()).slice(-10);
                errorLines.forEach(l => sendLog(`[Install Error] ${l.trim()}`));
                resolve({ success: false, logs });
            }
        });
        installProcess.on('error', (err) => resolve({ success: false, logs: err.message }));
    });
}
function runLocalBuild(projectPath, sendLog, isKo = true) {
    return new Promise((resolve) => {
        sendLog(isKo ? `[Validatix] 🔨 로컬 빌드 검증 중...` : `[Validatix] 🔨 Running local build...`);
        const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
        const buildProcess = exec(`${npmCmd} run build`, { cwd: projectPath, timeout: 120000 });
        let logs = '';
        const captureLog = (data) => { logs += data.toString(); };
        buildProcess.stdout.on('data', captureLog);
        buildProcess.stderr.on('data', captureLog);
        buildProcess.on('close', (code) => {
            if (code === 0) {
                sendLog(isKo ? `[Validatix] ✅ 로컬 빌드 성공.` : `[Validatix] ✅ Local build success.`);
                
                resolve({ success: true, logs });
            } else {
                sendLog(`[Validatix] 🔄 Optimizing design...`);
                const errorLines = logs.split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('×')).slice(0, 15);
                errorLines.forEach(l => sendLog(`[Build Error] ${l.trim()}`));
                resolve({ success: false, logs });
            }
        });
        buildProcess.on('error', (err) => resolve({ success: false, logs: err.message }));
    });
}

// ─────────────────────────────────────────────────────────────
// 13. Vercel 배포
// ─────────────────────────────────────────────────────────────
function runDeploy(projectPath, vercelToken, sendLog) {
    return new Promise((resolve) => {
        const npxCmd = process.platform === 'win32' ? 'npx.cmd' : 'npx';
        const deployCmd = `${npxCmd} vercel --prod --yes --token=${vercelToken}`;
        const deployProcess = exec(deployCmd, { cwd: projectPath, maxBuffer: 1024 * 1024 * 10 });
        let logs = "";
        const captureLog = (data) => { logs += data.toString(); };
        deployProcess.stdout.on('data', captureLog);
        deployProcess.stderr.on('data', captureLog);
        deployProcess.on('close', (code) => {
            // 실제 Vercel 출력 형식(▲ Aliased / ▲ Production)에서 주소 추출
            let url = "";
            const aliasMatch = logs.match(/Aliased\s+(https:\/\/[^\s]+\.vercel\.app)/);
            const prodMatch = logs.match(/Production\s+(https:\/\/[^\s]+\.vercel\.app)/);
            if (aliasMatch) url = aliasMatch[1];
            else if (prodMatch) url = prodMatch[1];
            else {
                const anyMatch = logs.match(/https:\/\/[a-zA-Z0-9._-]+\.vercel\.app/);
                if (anyMatch) url = anyMatch[0];
            }
            const success = code === 0 && !!url;
            if (!success) {
                const lines = logs.split('\n').filter(l => l.trim()).slice(-20);
                lines.forEach(l => sendLog(`[Vercel Log] ${l.trim()}`));
            }
            resolve({ success, logs, url });
        });
    });
}

// ─────────────────────────────────────────────────────────────
// 14. 메인 생성 엔진
// ─────────────────────────────────────────────────────────────
// 4-2. 시장조사 단독 API (PRD 완성 시 프론트에서 즉시 호출)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 4-3. 경쟁사분석 단독 API (PRD 완성 시 프론트에서 즉시 호출)
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// 섹션별 재생성 API (무한 디자인 자동생성)
// ─────────────────────────────────────────────────────────────
app.post('/api/regenerate-section', async (req, res) => {
    const { idea, section, currentJson } = req.body;
    if (!idea || !section || !currentJson) return res.status(400).json({ error: '입력값 누락' });

    const sectionPrompts = {
        hero: `You are a creative UI designer. Generate a NEW and DIFFERENT hero section for this app idea: "${idea}". Be creative and different from the current version. Output ONLY valid JSON, no markdown.
{
  "label_en": "Label text", "label_ko": "라벨",
  "title_en": "Main Title", "title_ko": "메인 타이틀",
  "subtitle_en": "Short subtitle.", "subtitle_ko": "서브 설명",
  "btn_primary_en": "Get Started",
  "btn_secondary_en": "View Demo",
  "stats": [
    { "number": "목표수치", "label_en": "Stat 1", "label_ko": "지표1" },
    { "number": "목표수치", "label_en": "Stat 2", "label_ko": "지표2" },
    { "number": "목표수치", "label_en": "Stat 3", "label_ko": "지표3" },
    { "number": "목표수치", "label_en": "Stat 4", "label_ko": "지표4" }
  ]
}
RULES: title_ko under 15 chars. subtitle_ko under 30 chars. stats numbers must be realistic goal-based. Output ONLY JSON.`,

        features: `You are a creative UI designer. Generate a NEW and DIFFERENT features section for this app idea: "${idea}". Use completely different feature descriptions and image seeds. Output ONLY valid JSON, no markdown.
{
  "label_en": "Features",
  "title_en": "Section Title", "title_ko": "섹션 타이틀",
  "subtitle_en": "Section subtitle.", "subtitle_ko": "섹션 설명",
  "items": [
    { "icon": "Zap", "image_seed": "word1", "tag_en": "Tag1", "tag_ko": "태그1", "title_en": "Feature 1", "title_ko": "기능 1", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" },
    { "icon": "Shield", "image_seed": "word2", "tag_en": "Tag2", "tag_ko": "태그2", "title_en": "Feature 2", "title_ko": "기능 2", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" },
    { "icon": "Brain", "image_seed": "word3", "tag_en": "Tag3", "tag_ko": "태그3", "title_en": "Feature 3", "title_ko": "기능 3", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" },
    { "icon": "BarChart2", "image_seed": "word4", "tag_en": "Tag4", "tag_ko": "태그4", "title_en": "Feature 4", "title_ko": "기능 4", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" },
    { "icon": "Globe", "image_seed": "word5", "tag_en": "Tag5", "tag_ko": "태그5", "title_en": "Feature 5", "title_ko": "기능 5", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" },
    { "icon": "Lock", "image_seed": "word6", "tag_en": "Tag6", "tag_ko": "태그6", "title_en": "Feature 6", "title_ko": "기능 6", "desc_en": "2-3 sentence description.", "desc_ko": "기능 설명" }
  ]
}
RULES: exactly 6 items. image_seed must be specific English nouns matching each feature. icon must be valid lucide-react name. Output ONLY JSON.`,

        stats: `You are a creative UI designer. Generate a NEW and DIFFERENT stats section for this app idea: "${idea}". Use different numbers and descriptions. Output ONLY valid JSON, no markdown.
{
  "label_en": "Performance",
  "title_en": "Proven Results", "title_ko": "성과 지표",
  "subtitle_en": "Short subtitle.", "subtitle_ko": "설명",
  "items": [
    { "number": "수치", "label_en": "Stat 1", "label_ko": "지표1", "desc_en": "Short desc.", "desc_ko": "설명" },
    { "number": "수치", "label_en": "Stat 2", "label_ko": "지표2", "desc_en": "Short desc.", "desc_ko": "설명" },
    { "number": "수치", "label_en": "Stat 3", "label_ko": "지표3", "desc_en": "Short desc.", "desc_ko": "설명" },
    { "number": "수치", "label_en": "Stat 4", "label_ko": "지표4", "desc_en": "Short desc.", "desc_ko": "설명" }
  ]
}
RULES: exactly 4 items. numbers must be realistic goal-based (목표 XX%, 목표 XXX명 etc). desc_ko under 15 chars. Output ONLY JSON.`
    };

    try {
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 2000,
            messages: [{ role: 'user', content: sectionPrompts[section] }]
        });

        const raw = result.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
        const newSection = JSON.parse(raw);

        // KO MAP 적용
        let mapped = { ...currentJson };
        if (section === 'hero') {
            mapped.hero = {
                ...newSection,
                label: { ko: newSection.label_ko, en: newSection.label_en },
                title: { ko: newSection.title_ko, en: newSection.title_en },
                subtitle: { ko: newSection.subtitle_ko, en: newSection.subtitle_en },
                btn_primary: { ko: '시작하기', en: newSection.btn_primary_en },
                btn_secondary: { ko: '데모 보기', en: newSection.btn_secondary_en },
                stats: newSection.stats.map(s => ({
                    number: s.number,
                    label: { ko: s.label_ko, en: s.label_en }
                }))
            };
        } else if (section === 'features') {
            mapped.features = {
                label: { ko: '핵심 기능', en: 'Features' },
                title: { ko: newSection.title_ko, en: newSection.title_en },
                subtitle: { ko: newSection.subtitle_ko, en: newSection.subtitle_en },
                items: newSection.items.map(item => ({
                    icon: item.icon,
                    image_seed: item.image_seed,
                    tag: { ko: item.tag_ko, en: item.tag_en },
                    title: { ko: item.title_ko, en: item.title_en },
                    desc: { ko: item.desc_ko, en: item.desc_en }
                }))
            };
        } else if (section === 'stats') {
            mapped.stats = {
                label: { ko: '성과 지표', en: 'Performance' },
                title: { ko: newSection.title_ko, en: newSection.title_en },
                subtitle: { ko: newSection.subtitle_ko, en: newSection.subtitle_en },
                items: newSection.items.map(item => ({
                    number: item.number,
                    label: { ko: item.label_ko, en: item.label_en },
                    desc: { ko: item.desc_ko, en: item.desc_en }
                }))
            };
        }

        res.json({ contentJson: mapped });
    } catch (e) {
        res.status(500).json({ error: `섹션 재생성 실패: ${e.message}` });
    }
});
app.post('/api/competitor-analysis', async (req, res) => {
    const { idea, prd, lang } = req.body;
    if (!idea || !prd) return res.status(400).json({ error: '입력값 누락' });
    try {
        const sendLog = () => {};
        const competitor = await generateCompetitorAnalysis(idea, prd, sendLog, lang);
        res.json({ competitor });
    } catch (e) {
        res.status(500).json({ error: '경쟁사분석 실패' });
    }
});
// ─────────────────────────────────────────────────────────────
// 4-4. 빠른 인사이트 API (Aha 1 - 9주차)
// ─────────────────────────────────────────────────────────────
app.post('/api/quick-insight', async (req, res) => {
    const { idea, lang } = req.body;
    const isKo = lang === 'ko';
    if (!idea) return res.status(400).json({ error: '아이디어 누락' });
    try {
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 1024,
            messages: [{ role: "user", content: `You are a business strategist. Analyze this app idea and provide instant key insights in ${isKo ? 'Korean' : 'English'}.

App idea: "${idea}"

Output ONLY valid JSON. No markdown, no explanation.

{
  "coreTarget": "핵심 타겟 고객 1줄 설명 (예: 도시 거주 30-40대 맞벌이 반려견 보호자)",
  "topCompetitors": ["경쟁사1", "경쟁사2", "경쟁사3"],
  "differentiators": ["차별화 포인트1 (1줄)", "차별화 포인트2 (1줄)", "차별화 포인트3 (1줄)"],
  "marketHook": "이 아이디어가 시장에서 통할 이유 1줄 (예: 반려견 산책 시장은 연 15% 성장 중이며 1인 가구 증가로 수요 폭발)"
}

RULES:
- coreTarget: 1 sentence, under 30 chars, specific demographic + psychographic
- topCompetitors: exactly 3 REAL company names (Korean or global). Never generic like "기존 서비스들". Competitors MUST offer the SAME core function as the idea. If the idea is an invoicing tool, competitors must be invoicing tools, not general freelancer platforms. If the idea is a pet walking app, competitors must be pet health/walking apps, not general fitness apps.
- differentiators: exactly 3 items, each under 25 chars, concrete and actionable
- marketHook: 1 sentence, under 40 chars, data-driven or trend-driven
- All text in ${isKo ? 'Korean' : 'English'}
- Output ONLY the JSON` }]
        });
        const raw = result.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
        const insight = JSON.parse(raw);
        res.json({ insight });
    } catch (e) {
        console.error('Quick insight error:', e.message);
        res.status(500).json({ error: '인사이트 생성 실패' });
    }
});
// ─────────────────────────────────────────────────────────────
// 파일 업로드 — 텍스트 추출 API (9주차)
// ─────────────────────────────────────────────────────────────
app.post('/api/extract-file', upload.single('file'), async (req, res) => {
    try {
        const file = req.file;
        if (!file) return res.status(400).json({ error: '파일 없음' });

        const ext = file.originalname.split('.').pop().toLowerCase();
        let text = '';

        // PDF
        if (ext === 'pdf') {
            const data = await pdfParse(file.buffer);
            text = data.text;
        }
        // DOCX
        else if (ext === 'docx') {
            const result = await mammoth.extractRawText({ buffer: file.buffer });
            text = result.value;
        }
        // 텍스트 계열 (txt, md, csv, json, js, jsx, ts, tsx, py, html, css)
        else if (['txt', 'md', 'csv', 'json', 'js', 'jsx', 'ts', 'tsx', 'py', 'html', 'css', 'java', 'php', 'go', 'swift', 'rb', 'sql', 'yaml', 'yml', 'xml', 'log', 'ini', 'cfg', 'sh'].includes(ext)) {
            text = file.buffer.toString('utf-8');
        }
        else {
            return res.status(400).json({ error: '지원하지 않는 파일 형식입니다.' });
        }

        // 텍스트가 너무 길면 잘라서 전송 (Claude 컨텍스트 제한 고려)
        const maxChars = 30000;
        if (text.length > maxChars) {
            text = text.substring(0, maxChars) + '\n\n... (파일이 너무 길어 일부만 표시됩니다)';
        }

        res.json({ text, fileName: file.originalname, fileSize: file.size, ext });
    } catch (e) {
        console.error('파일 추출 오류:', e.message);
        res.status(500).json({ error: '파일 처리 실패' });
    }
});
// ─────────────────────────────────────────────────────────────
// 마케팅 자동생성 Stage4 (9주차)
// ─────────────────────────────────────────────────────────────
app.post('/api/marketing', async (req, res) => {
    const { idea, prd, deployUrl, marketData, competitorData } = req.body;
    if (!idea || !prd) return res.status(400).json({ error: '입력값 누락' });

    const marketContext = marketData ? `
Market Research:
- TAM: ${marketData.tam} / SAM: ${marketData.sam} / SOM: ${marketData.som}
- Target: ${marketData.target}
- Score: ${marketData.score}/10
- Revenue Model: ${marketData.revenueModel}
- Start Price: ${marketData.startPrice}` : '';

    const competitorContext = competitorData ? `
Competitor Analysis:
- Competitors: ${competitorData.competitors?.map(c => c.name).join(', ')}
- Differentiation: ${competitorData.differentiation?.join(', ')}
- Opportunity: ${competitorData.opportunity}` : '';

    try {
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 8000,
            messages: [{ role: "user", content: `You are an elite marketing strategist. Create a comprehensive marketing launch package for this app.

App idea: "${idea}"
PRD: "${prd}"
Deployed URL: "${deployUrl || 'https://app.example.com'}"
${marketContext}
${competitorContext}

Output ONLY a valid JSON object. No markdown, no explanation.

{
  "channelStrategy": {
    "title": "채널 전략 분석",
    "primary": ["Korean: 1순위 채널 + 이유 (1줄)", "Korean: 2순위 채널 + 이유 (1줄)"],
    "secondary": ["Korean: 보조 채널 1 + 이유", "Korean: 보조 채널 2 + 이유"],
    "budget": "Korean: 예산 없을 때 추천 전략 1-2줄"
  },
  "snsCopy": {
    "title": "SNS 카피",
    "twitter": [
      "Korean: 트위터/X 런치 트윗 1 (max 280자, 해시태그 포함)",
      "Korean: 트위터/X 런치 트윗 2 (다른 각도)",
      "Korean: 트위터/X 런치 트윗 3 (사회적 증명 각도)"
    ],
    "linkedin": "Korean: LinkedIn 런치 포스트 (3-4문장, 전문적 톤)",
    "instagram": "Korean: Instagram 캡션 (2-3문장 + 해시태그 5개)"
  },
  "productHunt": {
    "title": "Product Hunt 런치 패키지",
    "tagline": "English: 60자 이내 tagline",
    "description": "English: 3-4 sentence description for PH listing",
    "firstComment": "English: Maker의 첫 댓글 (3-4 sentences, authentic tone)",
    "topics": ["topic1", "topic2", "topic3"]
  },
  "emailMarketing": {
    "title": "이메일 마케팅",
    "launch": {
      "subject": "Korean: 런치 알림 이메일 제목",
      "body": "Korean: 런치 알림 이메일 본문 (5-7줄, CTA 포함)"
    },
    "followUp": {
      "subject": "Korean: 7일 후 팔로업 이메일 제목",
      "body": "Korean: 팔로업 이메일 본문 (3-5줄)"
    },
    "conversion": {
      "subject": "Korean: 무료→유료 전환 이메일 제목",
      "body": "Korean: 전환 유도 이메일 본문 (4-6줄, 혜택 강조)"
    }
  },
  "adCopy": {
    "title": "광고 카피",
    "google": {
      "headlines": ["English: 30자 이내 헤드라인 1", "English: 30자 이내 헤드라인 2", "English: 30자 이내 헤드라인 3"],
      "descriptions": ["English: 90자 이내 설명 1", "English: 90자 이내 설명 2"]
    },
    "facebook": {
      "primaryText": "Korean: Facebook 광고 본문 (2-3문장)",
      "headline": "Korean: Facebook 광고 헤드라인 (1줄)",
      "description": "Korean: Facebook 광고 설명 (1줄)"
    }
  },
  "positioning": {
    "title": "포지셔닝 문구",
    "oneLiner": "Korean: 한 줄 포지셔닝 (예: 'X의 Y 버전' 또는 'A를 위한 B')",
    "elevator": "Korean: 30초 엘리베이터 피치 (3-4문장)",
    "vsCompetitors": [
      "Korean: vs 경쟁사1 — 우리가 더 나은 이유 (1줄)",
      "Korean: vs 경쟁사2 — 우리가 더 나은 이유 (1줄)",
      "Korean: vs 경쟁사3 — 우리가 더 나은 이유 (1줄)"
    ]
  },
  "community": {
    "title": "커뮤니티 공략",
    "reddit": {
      "subreddits": ["r/subreddit1", "r/subreddit2", "r/subreddit3"],
      "postTitle": "English: Reddit 포스트 제목",
      "postBody": "English: Reddit 포스트 본문 (3-4 sentences, no self-promotion tone)"
    },
    "indieHackers": "English: Indie Hackers 포스트 (3-4 sentences, building-in-public tone)",
    "discord": "Korean: Discord/커뮤니티 소개 메시지 (2-3문장)"
  },
  "localKR": {
    "title": "한국 로컬 채널",
    "everytime": "Korean: 에브리타임 자유게시판 글 (3-5문장, 광고 아닌 경험 공유 톤, '이런 앱 찾았는데' 형식)",
    "instagramReels": "Korean: Instagram 릴스/스토리 스크립트 (15초 분량, 후킹 첫 줄 + 핵심 기능 1개 + CTA)",
    "naverCafe": "Korean: 네이버 카페 후기 글 (3-4문장, 자연스러운 사용 후기 톤)"
  }
}

RULES:
- All Korean text must be natural, conversational Korean (not translated-sounding)
- Twitter copies: exactly 3 different angles. Include relevant hashtags
- Product Hunt: tagline MUST be under 60 chars. Topics must be real PH topics
- Google Ads headlines: MUST be under 30 chars each. Descriptions under 90 chars
- Email bodies: include the deployed URL naturally
- Positioning vsCompetitors: use REAL competitor names from the competitor analysis
- Reddit: suggest REAL subreddits relevant to this app's niche
- Community posts: must NOT sound like ads. Authentic, helpful tone
- Output ONLY the JSON` }]
        });

        const raw = result.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

        try {
            const marketing = JSON.parse(raw);
            res.json({ marketing });
        } catch(e) {
            // 파싱 실패 시 재시도
            const retryResult = await anthropic.messages.create({
                model: MODEL_CODER,
                max_tokens: 4096,
                messages: [
                    { role: "user", content: raw + "\n\nReturn ONLY valid JSON, no markdown." }
                ]
            });
            const retryRaw = retryResult.content[0].text.trim()
                .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();
            const marketing = JSON.parse(retryRaw);
            res.json({ marketing });
        }
    } catch (e) {
        console.error('Marketing generation error:', e.message);
        res.status(500).json({ error: '마케팅 생성 실패' });
    }
});
app.post('/api/market-research', async (req, res) => {
    const { idea, prd, lang } = req.body;
    if (!idea || !prd) return res.status(400).json({ error: '입력값 누락' });
    try {
        const sendLog = () => {};
        const market = await generateMarketResearch(idea, prd, sendLog, lang);
        res.json({ market });
    } catch (e) {
        res.status(500).json({ error: '시장조사 실패' });
    }
});
// ─────────────────────────────────────────────────────────────
app.post("/api/design", async (req, res) => {
    const { idea, prd, userId, contentJson, lang, existingMarket, existingCompetitor } = req.body;
let prebuiltJson = contentJson || null;
    let isPaidUser = false;
    if (userId) {
        try {
            const { data } = await supabaseAdmin.from('usage_limits').select('plan').eq('user_id', userId).single();
            isPaidUser = data?.plan !== 'free' && data?.plan != null;
        } catch(e) { isPaidUser = false; }
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const sendLog = (msg) => { console.log(msg); res.write(`data: ${JSON.stringify({ log: msg })}\n\n`); };
    const sendMarket = (market) => { res.write(`data: ${JSON.stringify({ market })}\n\n`); };
    const sendUrl = (url) => res.write(`data: ${JSON.stringify({ url })}\n\n`);
    const sendEnd = () => { res.write(`data: [DONE]\n\n`); res.end(); };

    try {
        const isKo = lang === 'ko';
        sendLog(isKo ? `[Validatix] 🚀 생성 자동화 엔진 점화!` : `[Validatix] 🚀 Engine ignited!`);

        // 4주차: 시장조사 자동화 — 앱 생성 전 먼저 실행
        let marketData = existingMarket || null;
        if (!marketData) {
        try {
            marketData = await generateMarketResearch(idea, prd, sendLog, lang);
            if (marketData) {
                sendMarket(marketData); // 프론트엔드로 시장조사 결과 전송
            }
        } catch(e) {
            sendLog(`⚠️ 시장조사 실패. 생성은 계속 진행합니다.`);
        }
        } else {
            sendLog(lang === 'ko' ? `[Claude] ✅ 기존 시장조사 결과 재사용 (${marketData.score}/10)` : `[Claude] ✅ Reusing existing market research (${marketData.score}/10)`);
            sendMarket(marketData);
        }

        // 5주차: 경쟁사분석 자동화
        let competitorData = existingCompetitor || null;
        if (!competitorData) {
        try {
            competitorData = await generateCompetitorAnalysis(idea, prd, sendLog, lang);
            if (competitorData) {
                res.write(`data: ${JSON.stringify({ competitor: competitorData })}\n\n`);
            }
        } catch(e) {
            sendLog(`⚠️ 경쟁사분석 실패. 생성은 계속 진행합니다.`);
        }
        } else {
            sendLog(lang === 'ko' ? `[Claude] ✅ 기존 경쟁사분석 결과 재사용` : `[Claude] ✅ Reusing existing competitor analysis`);
            res.write(`data: ${JSON.stringify({ competitor: competitorData })}\n\n`);
        }
        const expandedPrompt = await expandPrompt(idea, prd, marketData, competitorData);
        sendLog(isKo ? `[Validatix] 📝 프롬프트 증폭 완료.` : `[Validatix] 📝 Prompt amplified.`);

        const hasPrebuiltContent = prebuiltJson && prebuiltJson.stats?.items?.length > 0 && prebuiltJson.pricing?.plans?.length > 0 && prebuiltJson.features?.items?.length > 0;
if (!hasPrebuiltContent) {
  try {
    const previewJson = await generateContentJSON(idea, sendLog, lang, prd);
    res.write(`data: ${JSON.stringify({ contentJson: previewJson })}\n\n`);
    prebuiltJson = previewJson;
  } catch(e) {}
} else {
  res.write(`data: ${JSON.stringify({ contentJson: prebuiltJson })}\n\n`);
}
        let currentFiles = await generateMultiFileArchitecture(expandedPrompt, prd, marketData, sendLog, isPaidUser, prebuiltJson, lang);

        const projectName = `validatix-app-${Date.now()}`;
        const targetDir = path.join(__dirname, 'Generated_Projects');
        if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
        const projectPath = path.join(targetDir, projectName);

        sendLog(isKo ? `[Validatix] 📦 베이스 템플릿 복사 중...` : `[Validatix] 📦 Copying base template...`);
        const templateDir = path.join(__dirname, 'base-template');
        if (!fs.existsSync(templateDir)) {
            sendLog(`🔥 [Error] 베이스 템플릿이 없습니다.`);
            return sendEnd();
        }
        try {
            fs.cpSync(templateDir, projectPath, { recursive: true });
        } catch(e) {
            sendLog(`🔥 [Error] 템플릿 복사 실패: ${e.message}`);
            return sendEnd();
        }
        sendLog(isKo ? `[Validatix] ✅ 베이스 템플릿 복사 완료.` : `[Validatix] ✅ Base template ready.`);

        let appDir = path.join(projectPath, 'app');
        if (!fs.existsSync(appDir)) appDir = path.join(projectPath, 'src', 'app');
        const rootDir = fs.existsSync(path.join(projectPath, 'src')) ? path.join(projectPath, 'src') : projectPath;

        fs.writeFileSync(path.join(appDir, 'globals.css'), getBaseGlobalsCss(prebuiltJson?.style || {}));

        const deployedUrl = 'https://validatix.com';
        const sitemapXml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${deployedUrl}/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>${deployedUrl}/dashboard</loc>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>
</urlset>`;
        fs.writeFileSync(path.join(projectPath, 'public', 'sitemap.xml'), sitemapXml);

// SEO: robots.txt
const robotsTxt = `User-agent: *\nAllow: /\nDisallow: /dashboard\nDisallow: /auth\nSitemap: ${deployedUrl}/sitemap.xml`;
fs.writeFileSync(path.join(projectPath, 'public', 'robots.txt'), robotsTxt);
            sendLog(isKo ? `[Validatix] 🎨 디자인 시스템 적용 완료.` : `[Validatix] 🎨 Design system applied.`);
            fs.writeFileSync(path.join(appDir, 'layout.tsx'), getBaseLayout(prebuiltJson));
            sendLog(isKo ? `[Validatix] 🏗️ 레이아웃 적용 완료.` : `[Validatix] 🏗️ Layout applied.`);

            const nextConfigTsPath = path.join(projectPath, 'next.config.ts');
            const nextConfigMjsPath = path.join(projectPath, 'next.config.mjs');
            const configContent = `/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: { ignoreBuildErrors: true },
  images: { remotePatterns: [{ protocol: 'https', hostname: 'picsum.photos' }] },
  async headers() {
    return [{ source: '/(.*)', headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }, { key: 'X-Frame-Options', value: 'SAMEORIGIN' }] }];
  }
};
export default nextConfig;`;
            fs.writeFileSync(fs.existsSync(nextConfigTsPath) ? nextConfigTsPath : nextConfigMjsPath, configContent);
            
            // Vercel 플랫폼 레벨 헤더 설정 (X-Frame-Options 덮어쓰기 방지)
            const vercelJson = {
              headers: [
                {
                  source: "/(.*)",
                  headers: [
                    { key: "X-Frame-Options", value: "ALLOWALL" },
                    { key: "Content-Security-Policy", value: "frame-ancestors *" }
                  ]
                }
              ]
            };
            fs.writeFileSync(path.join(projectPath, 'vercel.json'), JSON.stringify(vercelJson, null, 2));
            
            const pkgPath = path.join(projectPath, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            pkg.scripts.build = 'next build';
            pkg.scripts.dev = 'next dev';
            fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
            sendLog(isKo ? `[Validatix] 🛡️ 빌드 설정 완료.` : `[Validatix] 🛡️ Build config ready.`);

            const defaultPagePath = path.join(appDir, 'page.tsx');
            if (fs.existsSync(defaultPagePath)) fs.unlinkSync(defaultPagePath);
            const componentsDir = path.join(rootDir, 'components');
            if (fs.existsSync(componentsDir)) fs.rmSync(componentsDir, { recursive: true, force: true });

            // ShadCN ui 컴포넌트 복구 (base-template에서 복사)
            const templateUiDir = path.join(__dirname, 'base-template', 'components', 'ui');
            const targetUiDir = path.join(rootDir, 'components', 'ui');
            if (fs.existsSync(templateUiDir)) {
                fs.mkdirSync(targetUiDir, { recursive: true });
                fs.readdirSync(templateUiDir).forEach(file => {
                    fs.copyFileSync(path.join(templateUiDir, file), path.join(targetUiDir, file));
                });
                sendLog(isKo ? `[Validatix] ✅ ShadCN UI 컴포넌트 복구 완료.` : `[Validatix] ✅ ShadCN UI components restored.`);
            }

            // ShadCN utils.ts 복구
            const templateUtilsPath = path.join(__dirname, 'base-template', 'lib', 'utils.ts');
            const targetUtilsPath = path.join(projectPath, 'lib', 'utils.ts');
            if (fs.existsSync(templateUtilsPath)) {
                const libDir = path.join(projectPath, 'lib');
                if (!fs.existsSync(libDir)) fs.mkdirSync(libDir, { recursive: true });
                fs.copyFileSync(templateUtilsPath, targetUtilsPath);
            }

            sendLog(isKo ? `[Validatix] 🔨 파일 조립 중...` : `[Validatix] 🔨 Assembling files...`);
            writeFilesToDisk(currentFiles, projectPath, appDir, rootDir);

            // 의존성 설치 (Railway/Linux: node_modules가 없으므로 빌드 전 설치)
            const installResult = await runInstall(projectPath, sendLog, isKo);
            if (!installResult.success) {
                sendLog(isKo ? `🔥 [Error] 의존성 설치 실패로 빌드를 진행할 수 없습니다.` : `🔥 [Error] Dependency install failed.`);
                return sendEnd();
            }
            
            // 사전 빌드 검증 (tsc --noEmit)
            const preBuildResult = await runPreBuildCheck(projectPath, currentFiles, sendLog, prebuiltJson, prebuiltJson?.style || {}, lang);
            if (preBuildResult.needsFix) {
                currentFiles = preBuildResult.files;
            }

            sendLog(isKo ? `[Validatix] 🎨 Tailwind 설정 완료.` : `[Validatix] 🎨 Tailwind configured.`);

            const vercelToken = process.env.VERCEL_TOKEN;
            if (!vercelToken) { sendLog(`🔥 [Error] VERCEL_TOKEN 누락`); return sendEnd(); }
            

            let attempt = 1;
            const MAX_ATTEMPTS = 4;
            let isDeployed = false;

            while (attempt <= MAX_ATTEMPTS && !isDeployed) {
                const buildResult = await runLocalBuild(projectPath, sendLog, isKo);
                if (buildResult.success) {                
                  sendLog(isKo ? `[Vercel] 🌍 배포 시도 (${attempt}/${MAX_ATTEMPTS})...` : `[Vercel] 🌍 Deploy attempt (${attempt}/${MAX_ATTEMPTS})...`);
                    const deployResult = await runDeploy(projectPath, vercelToken, sendLog);
                    if (deployResult.success && deployResult.url) {
                        sendLog(isKo ? `🌍 [Deploy Success] 배포 완료!` : `🌍 [Deploy Success] Deployed!`);
                        const dpOff = await disableDeploymentProtection(deployResult.url, vercelToken);
                        // 사용자 환경변수 설정 (배포 성공 후) — Stripe + 외부 API
                        if (prebuiltJson?.userStripeKey || (prebuiltJson?.userAPIKeys && Object.values(prebuiltJson.userAPIKeys).some(v => v))) {
                            try {
                                const fullHost = deployResult.url.replace('https://', '').split('.')[0];
                                const parts = fullHost.split('-');
                                const searchName = parts.slice(0, 3).join('-');
                                const projListRes = await fetch(`https://api.vercel.com/v9/projects?search=${searchName}`, {
                                    headers: { Authorization: `Bearer ${vercelToken}` }
                                });
                                const projListData = await projListRes.json();
                                const proj = projListData.projects?.find(p => fullHost.startsWith(p.name) || fullHost.includes(p.name)) || projListData.projects?.[0];
                                if (proj) {
                                    const envKeys = [
                                        { key: 'NEXT_PUBLIC_SITE_URL', value: deployResult.url }
                                    ];
                                    if (prebuiltJson.userStripeKey) envKeys.push({ key: 'USER_STRIPE_SECRET_KEY', value: prebuiltJson.userStripeKey });
                                    const apiKeys = prebuiltJson.userAPIKeys || {};
                                    if (apiKeys.googleMapsKey) envKeys.push({ key: 'NEXT_PUBLIC_GOOGLE_MAPS_KEY', value: apiKeys.googleMapsKey });
                                    if (apiKeys.resendKey) envKeys.push({ key: 'RESEND_API_KEY', value: apiKeys.resendKey });
                                    if (apiKeys.openaiKey) envKeys.push({ key: 'OPENAI_API_KEY', value: apiKeys.openaiKey });
                                    if (apiKeys.openaiModel) envKeys.push({ key: 'OPENAI_MODEL', value: apiKeys.openaiModel });
                                    if (apiKeys.cloudinaryName) envKeys.push({ key: 'CLOUDINARY_CLOUD_NAME', value: apiKeys.cloudinaryName });
                                    if (apiKeys.cloudinaryPreset) envKeys.push({ key: 'CLOUDINARY_UPLOAD_PRESET', value: apiKeys.cloudinaryPreset });
                                    if (apiKeys.googleCalendarKey) envKeys.push({ key: 'GOOGLE_CALENDAR_API_KEY', value: apiKeys.googleCalendarKey });
                                    if (apiKeys.gaId) envKeys.push({ key: 'NEXT_PUBLIC_GA_MEASUREMENT_ID', value: apiKeys.gaId });
                                    if (apiKeys.twilioSid) envKeys.push({ key: 'TWILIO_ACCOUNT_SID', value: apiKeys.twilioSid });
                                    if (apiKeys.twilioToken) envKeys.push({ key: 'TWILIO_AUTH_TOKEN', value: apiKeys.twilioToken });
                                    if (apiKeys.twilioPhone) envKeys.push({ key: 'TWILIO_PHONE_NUMBER', value: apiKeys.twilioPhone });
                                    for (const env of envKeys) {
                                        // 기존 동일 키 삭제
                                        const listRes = await fetch(`https://api.vercel.com/v9/projects/${proj.id}/env`, {
                                            headers: { Authorization: `Bearer ${vercelToken}` }
                                        });
                                        const listData = await listRes.json();
                                        const existing = listData.envs?.find(e => e.key === env.key);
                                        if (existing) {
                                            await fetch(`https://api.vercel.com/v9/projects/${proj.id}/env/${existing.id}`, {
                                                method: 'DELETE',
                                                headers: { Authorization: `Bearer ${vercelToken}` }
                                            });
                                        }
                                        // 새 환경변수 추가 (encrypted)
                                        await fetch(`https://api.vercel.com/v10/projects/${proj.id}/env`, {
                                            method: 'POST',
                                            headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
                                            body: JSON.stringify({ key: env.key, value: env.value, type: 'encrypted', target: ['production', 'preview'] })
                                        });
                                    }
                                    sendLog(`[Vercel] 🔐 Stripe 환경변수 설정 완료.`);
                                } else {
                                    sendLog(`[Vercel] ⚠️ 프로젝트 매칭 실패. Stripe 환경변수 수동 설정 필요.`);
                                }
                            } catch(e) {
                                sendLog(`[Vercel] ⚠️ Stripe 환경변수 설정 실패: ${e.message}`);
                            }
                        }
                        // ───── 소스코드 ZIP 자동 생성 (15주차, archiver) — Starter+ 전용 ─────
                        if (isPaidUser) {
                            try {
                                const sourceDownloadsDir = path.join(__dirname, 'Source_Downloads');
                                if (!fs.existsSync(sourceDownloadsDir)) fs.mkdirSync(sourceDownloadsDir, { recursive: true });
                                const zipFileName = `${projectName}.zip`;
                                const zipFilePath = path.join(sourceDownloadsDir, zipFileName);
                                if (fs.existsSync(zipFilePath)) fs.unlinkSync(zipFilePath);

                                await new Promise((resolve, reject) => {
                                    const output = fs.createWriteStream(zipFilePath);
                                    const archive = archiver('zip', { zlib: { level: 9 } });
                                    output.on('close', resolve);
                                    output.on('error', reject);
                                    archive.on('error', reject);
                                    archive.pipe(output);
                                    archive.glob('**/*', {
                                        cwd: projectPath,
                                        dot: true,
                                        ignore: ['**/node_modules/**', '**/.next/**', '**/.vercel/**']
                                    });
                                    archive.finalize();
                                });

                                sendLog(isKo ? `[Validatix] ✅ 소스코드 ZIP 생성 완료.` : `[Validatix] ✅ Source code ZIP ready.`);
                                res.write(`data: ${JSON.stringify({ sourceZip: zipFileName })}\n\n`);
                            } catch (zipErr) {
                                sendLog(isKo ? `[Validatix] ⚠️ ZIP 생성 실패 (배포는 정상): ${zipErr.message}` : `[Validatix] ⚠️ ZIP failed (deploy OK): ${zipErr.message}`);
                            }
                        } else {
                            sendLog(isKo ? `[Validatix] 🔒 소스코드 다운로드는 Starter 플랜 이상에서 제공됩니다.` : `[Validatix] 🔒 Source code download is available on Starter plan and above.`);
                        }
                        sendUrl(deployResult.url);
                        isDeployed = true;
                    } else {
                        sendLog(`⚠️ Vercel 배포 실패. 재시도...`);
                        attempt++;
                    }
                } else {
                    if (attempt < MAX_ATTEMPTS) {
                        currentFiles = await fixWithQA(buildResult.logs, currentFiles, sendLog, prebuiltJson, prebuiltJson?.style || {}, lang);
                        writeFilesToDisk(currentFiles, projectPath, appDir, rootDir);
                        attempt++;
                    } else { break; }
                }
            }

            if (!isDeployed) sendLog(`🔥 [Deploy Failed] 배포 연속 실패.`);
            sendEnd();
    } catch (error) {
        sendLog(`🔥 [System Halt] ${error.message}`);
        sendEnd();
    }
});

// ─────────────────────────────────────────────────────────────
// 15. Stripe 결제
// ─────────────────────────────────────────────────────────────
app.post('/api/create-checkout-session', async (req, res) => {
    try {
        const { plan, userId, userEmail } = req.body;
        const priceMap = {
            starter:  process.env.STRIPE_PRICE_STARTER,
            pro:      process.env.STRIPE_PRICE_PRO,
            business: process.env.STRIPE_PRICE_BUSINESS,
        };
        const priceId = priceMap[plan];
        if (!priceId) return res.status(400).json({ error: '유효하지 않은 플랜입니다.' });
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: userEmail,
            metadata: { userId, plan },
            success_url: `${process.env.CLIENT_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.CLIENT_URL}/`,
        });
        res.json({ url: session.url });
    } catch (error) {
        console.error('Stripe 오류:', error);
        res.status(500).json({ error: '결제 세션 생성 실패' });
    }
});
app.post('/api/create-portal-session', async (req, res) => {
    try {
        const { userId } = req.body;
        if (!userId) return res.status(400).json({ error: '로그인이 필요합니다.' });

        const { data } = await supabaseAdmin
            .from('usage_limits')
            .select('stripe_customer_id')
            .eq('user_id', userId)
            .single();

        if (!data || !data.stripe_customer_id) {
            return res.status(400).json({ error: '구독 정보를 찾을 수 없습니다. 결제한 계정만 구독 관리가 가능합니다.' });
        }

        const portalSession = await stripe.billingPortal.sessions.create({
            customer: data.stripe_customer_id,
            return_url: `${process.env.CLIENT_URL}/pricing`,
        });

        res.json({ url: portalSession.url });
    } catch (error) {
        console.error('Portal 세션 오류:', error);
        res.status(500).json({ error: '구독 관리 페이지 생성 실패' });
    }
});

// ─────────────────────────────────────────────────────────────
// 13-1. Vercel Deployment Protection 자동 비활성화
// ─────────────────────────────────────────────────────────────
async function disableDeploymentProtection(deployUrl, vercelToken) {
    try {
        // 배포 URL에서 프로젝트명 추출 (예: validatix-app-1775990188309-xxxxx.vercel.app → validatix-app-1775990188309)
        const fullHost = deployUrl.replace('https://', '').split('.')[0];
        // Vercel가 붙이는 랜덤 suffix 제거 (마지막 -xxxx 부분)
        const parts = fullHost.split('-');
        // validatix-app-{timestamp} 형태로 추출 (앞 3개 파트)
        const projectName = parts.slice(0, 3).join('-');
        
        console.log(`[DP Debug] fullHost: ${fullHost}, projectName: ${projectName}`);
        
        const listRes = await fetch(`https://api.vercel.com/v9/projects?search=${projectName}`, {
            headers: { Authorization: `Bearer ${vercelToken}` }
        });
        const listData = await listRes.json();
        
        console.log(`[DP Debug] 검색 결과: ${listData.projects?.length || 0}개 프로젝트`);
        if (listData.projects?.length > 0) {
            console.log(`[DP Debug] 첫 번째 프로젝트: ${listData.projects[0].name}`);
        }
        
        // 매칭: 프로젝트명이 fullHost에 포함되거나, fullHost가 프로젝트명으로 시작하는 경우
        const project = listData.projects?.find(p => fullHost.startsWith(p.name) || fullHost.includes(p.name));
        if (!project && listData.projects?.length === 0) {
            console.log(`[DP Debug] 검색 결과 0개. 2초 후 재시도...`);
            await new Promise(r => setTimeout(r, 2000));
            const retryRes = await fetch(`https://api.vercel.com/v9/projects?search=${projectName}`, {
                headers: { Authorization: `Bearer ${vercelToken}` }
            });
            const retryData = await retryRes.json();
            console.log(`[DP Debug] 재시도 결과: ${retryData.projects?.length || 0}개 프로젝트`);
            if (retryData.projects?.length > 0) {
                const retryProject = retryData.projects.find(p => fullHost.startsWith(p.name) || fullHost.includes(p.name)) || retryData.projects[0];
                console.log(`[DP Debug] 재시도 매칭: ${retryProject.name} (${retryProject.id})`);
                const retryUpdate = await fetch(`https://api.vercel.com/v9/projects/${retryProject.id}`, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ssoProtection: null })
                });
                const retryBody = await retryUpdate.text();
                console.log(`[DP Debug] 재시도 업데이트: ${retryUpdate.status} / ${retryBody}`);
                return retryUpdate.ok;
            }
        }
        if (!project) {
            console.log(`[DP Debug] 프로젝트 매칭 실패. 검색어: ${projectName}`);
            // 폴백: 가장 최근 프로젝트 사용
            if (listData.projects?.length > 0) {
                const fallback = listData.projects[0];
                console.log(`[DP Debug] 폴백 사용: ${fallback.name}`);
                const updateRes = await fetch(`https://api.vercel.com/v9/projects/${fallback.id}`, {
                    method: 'PATCH',
                    headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ ssoProtection: null })
                });
                console.log(`[DP Debug] 폴백 업데이트 결과: ${updateRes.status}`);
                return updateRes.ok;
            }
            return false;
        }
        
        console.log(`[DP Debug] 프로젝트 매칭 성공: ${project.name} (${project.id})`);
        const updateRes = await fetch(`https://api.vercel.com/v9/projects/${project.id}`, {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${vercelToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ssoProtection: null })
        });
        const updateBody = await updateRes.text();
        console.log(`[DP Debug] 업데이트 결과: ${updateRes.status} / ${updateBody}`);
        return updateRes.ok;
    } catch(e) {
        console.log(`[DP Debug] 에러: ${e.message}`);
        return false;
    }
}
// ───── ZIP 제외 목록 파일 생성 (15주차) ─────
const zipExcludePath = path.join(__dirname, 'zip_exclude.txt');
if (!fs.existsSync(zipExcludePath)) {
    fs.writeFileSync(zipExcludePath, 'node_modules\\\r\n.next\\\r\n.vercel\\\r\n');
}

// ─────────────────────────────────────────────────────────────
// 소스코드 편집 API (16주차 — 코드 직접 편집)
// ─────────────────────────────────────────────────────────────
app.get('/api/source-files/:projectName', (req, res) => {
    const { projectName } = req.params;
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
    if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }
    const SKIP = new Set(['node_modules', '.next', '.vercel', '.git', 'package-lock.json', '_history']);
    const ALLOWED_EXT = new Set(['.tsx', '.ts', '.js', '.jsx', '.css', '.json', '.md', '.txt', '.mjs']);
    
    function scanDir(dirPath, relativePath = '') {
        const entries = [];
        try {
            const items = fs.readdirSync(dirPath);
            for (const item of items) {
                if (SKIP.has(item) || item.startsWith('.')) continue;
                const fullPath = path.join(dirPath, item);
                const relPath = relativePath ? `${relativePath}/${item}` : item;
                const stat = fs.statSync(fullPath);
                if (stat.isDirectory()) {
                    const children = scanDir(fullPath, relPath);
                    if (children.length > 0) {
                        entries.push({ name: item, path: relPath, type: 'dir', children });
                    }
                } else {
                    const ext = path.extname(item).toLowerCase();
                    if (ALLOWED_EXT.has(ext)) {
                        entries.push({ name: item, path: relPath, type: 'file' });
                    }
                }
            }
        } catch (e) {}
        return entries;
    }
    
    const tree = scanDir(projectPath);
    res.json({ tree, projectName: safeName });
});

app.get('/api/source-file/:projectName/{*filePath}', (req, res) => {
    const { projectName } = req.params;
    const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeFilePath = filePath.replace(/\.\./g, '');
    const fullPath = path.join(__dirname, 'Generated_Projects', safeName, safeFilePath);
    if (!fs.existsSync(fullPath)) {
        return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
    }
    try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const ext = path.extname(fullPath).toLowerCase();
        const langMap = { '.tsx': 'typescript', '.ts': 'typescript', '.js': 'javascript', '.jsx': 'javascript', '.css': 'css', '.json': 'json', '.md': 'markdown', '.mjs': 'javascript' };
        res.json({ content, language: langMap[ext] || 'plaintext', path: safeFilePath });
    } catch (e) {
        res.status(500).json({ error: '파일 읽기 실패' });
    }
});

app.post('/api/save-source-file', (req, res) => {
    const { projectName, filePath, content } = req.body;
    if (!projectName || !filePath || content === undefined) {
        return res.status(400).json({ error: '입력값 누락' });
    }
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeFilePath = filePath.replace(/\.\./g, '');
    const fullPath = path.join(__dirname, 'Generated_Projects', safeName, safeFilePath);
    if (!fs.existsSync(path.dirname(fullPath))) {
        return res.status(404).json({ error: '경로를 찾을 수 없습니다.' });
    }
    try {
        fs.writeFileSync(fullPath, content, 'utf-8');
        res.json({ success: true, path: safeFilePath });
    } catch (e) {
        res.status(500).json({ error: '파일 저장 실패' });
    }
});

// ─────────────────────────────────────────────────────────────
// AI 채팅 코드 수정 API (16주차)
// ─────────────────────────────────────────────────────────────
app.post('/api/chat-edit', async (req, res) => {
    const { projectName, message, currentFile, lockedFiles, mode } = req.body;
    if (!projectName || !message) {
        return res.status(400).json({ error: '입력값 누락' });
    }
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
    if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }

    try {
        // ── Discussion Mode: 코드 수정 없이 답변만 ──
        if (mode === 'discuss') {
            let fileContext = '';
            if (currentFile) {
                const filePath = path.join(projectPath, currentFile);
                if (fs.existsSync(filePath)) {
                    const code = fs.readFileSync(filePath, 'utf-8');
                    fileContext = `\n\nCurrent file: ${currentFile}\n\`\`\`\n${code}\n\`\`\``;
                }
            }
            const result = await anthropic.messages.create({
                model: MODEL_CODER,
                max_tokens: 2048,
                messages: [{ role: 'user', content: `You are a senior developer assistant. Answer the following question about a Next.js project. Be concise and helpful. Respond in the same language as the question.\n\nFORMATTING RULES (MANDATORY):\n- NEVER use markdown syntax: no ##, no **, no ---, no \`\`\`, no - bullet lists\n- Write in natural conversational tone, like a colleague explaining over chat\n- Use numbered lists with "1. 2. 3." only when listing steps\n- Use "• " for bullet points if needed\n- For code references, just mention the function/variable name naturally without code blocks\n- Keep it friendly and direct${fileContext}\n\nQuestion: ${message}` }]
            });
            return res.json({
                explanation: result.content[0].text.trim(),
                files: [],
                terminalCommands: []
            });
        }

        // ── Edit Mode ──
        const SKIP = new Set(['node_modules', '.next', '.vercel', '.git', 'package-lock.json', '_history']);
        const ALLOWED_EXT = new Set(['.tsx', '.ts', '.js', '.jsx', '.css', '.json', '.md', '.mjs']);

        // 파일 트리 수집 (Auto-locate용)
        function collectFiles(dirPath, relativePath = '') {
            const files = [];
            try {
                const items = fs.readdirSync(dirPath);
                for (const item of items) {
                    if (SKIP.has(item) || item.startsWith('.')) continue;
                    const fullPath = path.join(dirPath, item);
                    const relPath = relativePath ? `${relativePath}/${item}` : item;
                    const stat = fs.statSync(fullPath);
                    if (stat.isDirectory()) {
                        files.push(...collectFiles(fullPath, relPath));
                    } else {
                        const ext = path.extname(item).toLowerCase();
                        if (ALLOWED_EXT.has(ext)) files.push(relPath);
                    }
                }
            } catch (e) {}
            return files;
        }

        const allFiles = collectFiles(projectPath);
        const locked = Array.isArray(lockedFiles) ? new Set(lockedFiles) : new Set();

        // Target file이 있으면 해당 파일 코드를 직접 전달 (1단계 스킵)
        // Target file이 없으면 전체 파일 트리로 AI가 대상 파일을 자동 탐색 (Auto-locate)
        let targetFileContent = '';
        let targetFilePath = '';
        if (currentFile && fs.existsSync(path.join(projectPath, currentFile.replace(/\.\./g, '')))) {
            targetFilePath = currentFile.replace(/\.\./g, '');
            targetFileContent = fs.readFileSync(path.join(projectPath, targetFilePath), 'utf-8');
        }

        const lockedNote = locked.size > 0
            ? `\n\nLOCKED FILES (DO NOT MODIFY): ${[...locked].join(', ')}`
            : '';

        const systemPrompt = targetFileContent
            ? `You are a senior Next.js developer. The user wants to modify code in their project.

CURRENT FILE: ${targetFilePath}
\`\`\`
${targetFileContent.substring(0, 15000)}
\`\`\`
${lockedNote}

RULES:
1. Respond ONLY with a valid JSON object. No markdown, no explanation outside JSON.
2. JSON format:
{
  "explanation": "What you changed and why (in the user's language)",
  "files": [
    {
      "filePath": "exact/file/path",
      "newContent": "complete new file content"
    }
  ],
  "terminalCommands": []
}
3. "files" array: include ONLY files you actually modified. Each file must contain the COMPLETE new content (not a diff).
4. "terminalCommands": include ONLY if npm install or build is needed (e.g. ["npm install axios"]). Otherwise empty array.
5. If the user asks to install a package, add the npm install command AND update the relevant import in the code.
6. Do NOT modify locked files.
7. Preserve all existing functionality. Only change what the user asked for.
8. Output ONLY the JSON.`
            : `You are a senior Next.js developer. The user wants to modify code but did not specify which file.

PROJECT FILES:
${allFiles.join('\n')}
${lockedNote}

RULES:
1. Analyze the user's request and determine which file(s) need modification.
2. Read the target file(s) content — I will provide it in the next step if needed.
3. For now, identify the target files and respond with this JSON:
{
  "explanation": "What you will change and why (in the user's language)",
  "targetFiles": ["file/path/1", "file/path/2"],
  "needsFileContent": true
}
4. Output ONLY the JSON.`;

        const messages = [{ role: 'user', content: `${systemPrompt}\n\nUser request: ${message}` }];
        const result = await anthropic.messages.create({
            model: MODEL_CODER,
            max_tokens: 8192,
            messages
        });

        const rawText = result.content[0].text.trim()
            .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

        let parsed;
        try {
            parsed = JSON.parse(rawText);
        } catch (e) {
            return res.json({ explanation: rawText, files: [], terminalCommands: [] });
        }

        // Auto-locate 2단계: AI가 파일을 지목한 경우 해당 파일 내용을 읽어서 재호출
        if (parsed.needsFileContent && Array.isArray(parsed.targetFiles) && parsed.targetFiles.length > 0) {
            const fileContents = parsed.targetFiles
                .filter(f => !locked.has(f))
                .map(f => {
                    const safePath = f.replace(/\.\./g, '');
                    const fullPath = path.join(projectPath, safePath);
                    if (fs.existsSync(fullPath)) {
                        return { path: safePath, content: fs.readFileSync(fullPath, 'utf-8').substring(0, 12000) };
                    }
                    return null;
                })
                .filter(Boolean);

            const round2Prompt = `You are a senior Next.js developer. Modify the following files based on the user's request.

${fileContents.map(f => `FILE: ${f.path}\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n')}
${lockedNote}

User request: ${message}

RULES:
1. Respond ONLY with valid JSON:
{
  "explanation": "What you changed and why (in the user's language)",
  "files": [
    { "filePath": "exact/file/path", "newContent": "complete new file content" }
  ],
  "terminalCommands": []
}
2. Each file in "files" must have COMPLETE new content.
3. Do NOT modify locked files.
4. "terminalCommands": only if npm install or build is needed. Otherwise empty array [].
5. Output ONLY the JSON.`;

            const result2 = await anthropic.messages.create({
                model: MODEL_CODER,
                max_tokens: 8192,
                messages: [{ role: 'user', content: round2Prompt }]
            });

            const rawText2 = result2.content[0].text.trim()
                .replace(/^```json\n?/g, '').replace(/^```\n?/g, '').replace(/```$/g, '').trim();

            try {
                parsed = JSON.parse(rawText2);
            } catch (e) {
                return res.json({ explanation: rawText2, files: [], terminalCommands: [] });
            }
        }

        // 수정 전 원본 코드를 originalContent에 추가 (Diff Preview용)
        if (Array.isArray(parsed.files)) {
            for (const file of parsed.files) {
                if (locked.has(file.filePath)) continue;
                const safePath = (file.filePath || '').replace(/\.\./g, '');
                const fullPath = path.join(projectPath, safePath);
                if (fs.existsSync(fullPath)) {
                    file.originalContent = fs.readFileSync(fullPath, 'utf-8');
                } else {
                    file.originalContent = '';
                }
            }
            // locked 파일 제거
            parsed.files = parsed.files.filter(f => !locked.has(f.filePath));
        }

        res.json({
            explanation: parsed.explanation || '',
            files: parsed.files || [],
            terminalCommands: parsed.terminalCommands || []
        });

    } catch (error) {
        console.error('Chat-edit error:', error.message);
        res.status(500).json({ error: `AI 코드 수정 실패: ${error.message}` });
    }
});

// ─────────────────────────────────────────────────────────────
// AI 채팅 코드 수정 — 적용 확정 API (16주차)
// 사용자가 Diff Preview에서 "적용" 클릭 시 실제 파일 저장 + 히스토리 백업
// ─────────────────────────────────────────────────────────────
app.post('/api/chat-edit-apply', async (req, res) => {
    const { projectName, files } = req.body;
    if (!projectName || !Array.isArray(files) || files.length === 0) {
        return res.status(400).json({ error: '입력값 누락' });
    }
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
    if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }

    const results = [];
    for (const file of files) {
        const safePath = (file.filePath || '').replace(/\.\./g, '');
        const fullPath = path.join(projectPath, safePath);

        try {
            // 버전 히스토리 백업
            if (fs.existsSync(fullPath)) {
                const historyDir = path.join(projectPath, '_history', safePath);
                if (!fs.existsSync(historyDir)) fs.mkdirSync(historyDir, { recursive: true });
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const backupPath = path.join(historyDir, `${timestamp}.bak`);
                fs.copyFileSync(fullPath, backupPath);

                // 최대 10개 버전 유지
                const backups = fs.readdirSync(historyDir).sort();
                while (backups.length > 10) {
                    fs.unlinkSync(path.join(historyDir, backups.shift()));
                }
            }

            // 새 코드 저장
            const dir = path.dirname(fullPath);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(fullPath, file.newContent, 'utf-8');
            results.push({ filePath: safePath, success: true });
        } catch (e) {
            results.push({ filePath: safePath, success: false, error: e.message });
        }
    }

    res.json({ results });
});

// ───── 내장 DB 관리 대시보드 (16주차) ─────
app.get('/api/db-tables/:projectName', async (req, res) => {
  try {
    const { projectName } = req.params;
    if (!projectName) return res.status(400).json({ error: 'projectName required' });

    // pg 직접 쿼리로 테이블 목록 조회 (가장 확실한 방법)
    const result = await pgPool.query(`
      SELECT table_name FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT LIKE 'pg_%'
      ORDER BY table_name
    `);
    const tables = (result.rows || []).map(r => r.table_name).filter(t => !t.startsWith('_'));
    res.json({ tables });
  } catch (e) {
    console.error('DB tables error:', e.message);
    res.status(500).json({ error: 'Failed to fetch tables' });
  }
});

app.get('/api/db-rows/:projectName/:tableName', async (req, res) => {
  try {
    const { projectName, tableName } = req.params;
    const page = parseInt(req.query.page) || 0;
    const limit = 50;

    const { createClient } = require('@supabase/supabase-js');
    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error, count } = await sbAdmin
      .from(tableName)
      .select('*', { count: 'exact' })
      .range(page * limit, (page + 1) * limit - 1)
      .order('created_at', { ascending: false, nullsFirst: false });

    if (error) return res.status(500).json({ error: error.message });

    // 컬럼 정보 추출 (첫 행 기반, 없으면 pg로 직접 조회)
    let columns = data && data.length > 0 ? Object.keys(data[0]) : [];
    if (columns.length === 0) {
      try {
        const colResult = await pgPool.query(`
          SELECT column_name FROM information_schema.columns 
          WHERE table_schema = 'public' AND table_name = $1 
          ORDER BY ordinal_position
        `, [tableName]);
        columns = colResult.rows.map(r => r.column_name);
      } catch (e) {}
    }

    res.json({ rows: data || [], columns, total: count || 0, page, limit });
  } catch (e) {
    console.error('DB rows error:', e.message);
    res.status(500).json({ error: 'Failed to fetch rows' });
  }
});

app.post('/api/db-row/:projectName/:tableName', async (req, res) => {
  try {
    const { projectName, tableName } = req.params;
    const { row } = req.body;
    if (!row) return res.status(400).json({ error: 'row data required' });

    const { createClient } = require('@supabase/supabase-js');
    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await sbAdmin.from(tableName).insert(row).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, row: data?.[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to insert row' });
  }
});

app.put('/api/db-row/:projectName/:tableName/:id', async (req, res) => {
  try {
    const { projectName, tableName, id } = req.params;
    const { row } = req.body;
    if (!row) return res.status(400).json({ error: 'row data required' });

    const { createClient } = require('@supabase/supabase-js');
    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { data, error } = await sbAdmin.from(tableName).update(row).eq('id', id).select();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true, row: data?.[0] });
  } catch (e) {
    res.status(500).json({ error: 'Failed to update row' });
  }
});

app.delete('/api/db-row/:projectName/:tableName/:id', async (req, res) => {
  try {
    const { projectName, tableName, id } = req.params;

    const { createClient } = require('@supabase/supabase-js');
    const sbAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    const { error } = await sbAdmin.from(tableName).delete().eq('id', id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Failed to delete row' });
  }
});

// ───── 템플릿/디자인 시스템 (16주차) ─────
app.get('/api/templates', (req, res) => {
  const templates = [
    {
      id: 'saas-landing',
      category: 'SaaS',
      name: { ko: 'SaaS 랜딩페이지', en: 'SaaS Landing Page' },
      description: { ko: '구독형 서비스를 위한 전문 랜딩페이지. Hero, 기능 소개, 가격표, FAQ 포함.', en: 'Professional landing page for subscription services. Includes Hero, Features, Pricing, FAQ.' },
      thumbnail: 'https://picsum.photos/seed/saas/400/250',
      prdTemplate: {
        ko: '구독형 SaaS 웹 서비스 랜딩페이지. 핵심 기능 3~5개 소개, 가격 플랜 3개(Free/Pro/Enterprise), FAQ 5개, 뉴스레터 구독 폼, 소셜 로그인(Google), 대시보드 페이지.',
        en: 'Subscription SaaS web service landing page. 3-5 core features, 3 pricing plans (Free/Pro/Enterprise), 5 FAQs, newsletter signup, social login (Google), dashboard page.'
      },
      contentJsonBase: {
        navbar: { logo: 'MyApp', links_i18n: [{ ko: '기능', en: 'Features' }, { ko: '가격', en: 'Pricing' }, { ko: 'FAQ', en: 'FAQ' }] },
        hero: { title: { ko: '더 스마트한 업무 환경', en: 'Smarter Work Environment' }, subtitle: { ko: '팀의 생산성을 혁신적으로 높여주는 올인원 플랫폼', en: 'All-in-one platform that revolutionizes team productivity' }, btn_primary: { ko: '무료로 시작', en: 'Start Free' }, btn_secondary: { ko: '데모 보기', en: 'Watch Demo' } },
        style: { primaryColor: '#3b82f6', bgColor: '#0f0f0f', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }
      }
    },
    {
      id: 'portfolio',
      category: 'Portfolio',
      name: { ko: '포트폴리오', en: 'Portfolio' },
      description: { ko: '개인 포트폴리오 & 이력서 사이트. 프로젝트 갤러리, 자기소개, 연락처 폼 포함.', en: 'Personal portfolio & resume site. Project gallery, bio, contact form included.' },
      thumbnail: 'https://picsum.photos/seed/portfolio/400/250',
      prdTemplate: {
        ko: '개인 포트폴리오 웹사이트. Hero(이름+한줄소개), 프로젝트 갤러리(이미지+설명 6개), About Me 섹션, 기술 스택 목록, 연락처 폼(이메일), 소셜 링크(GitHub/LinkedIn).',
        en: 'Personal portfolio website. Hero (name+tagline), project gallery (6 items with images), About Me section, tech stack list, contact form (email), social links (GitHub/LinkedIn).'
      },
      contentJsonBase: {
        navbar: { logo: 'John Doe', links_i18n: [{ ko: '프로젝트', en: 'Projects' }, { ko: '소개', en: 'About' }, { ko: '연락', en: 'Contact' }] },
        hero: { title: { ko: '안녕하세요, 저는 개발자입니다', en: 'Hi, I\'m a Developer' }, subtitle: { ko: '웹과 모바일 경험을 디자인하고 구축합니다', en: 'I design and build web & mobile experiences' }, btn_primary: { ko: '프로젝트 보기', en: 'View Projects' }, btn_secondary: { ko: '연락하기', en: 'Contact Me' } },
        style: { primaryColor: '#8b5cf6', bgColor: '#0a0a0a', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }
      }
    },
    {
      id: 'ecommerce',
      category: 'E-commerce',
      name: { ko: '쇼핑몰', en: 'E-commerce Store' },
      description: { ko: '상품 판매를 위한 온라인 스토어. 상품 목록, 장바구니, 결제 연동 포함.', en: 'Online store for product sales. Product listings, cart, payment integration included.' },
      thumbnail: 'https://picsum.photos/seed/ecommerce/400/250',
      prdTemplate: {
        ko: '온라인 쇼핑몰. 상품 목록(카테고리별 필터), 상품 상세 페이지, 장바구니, Stripe 결제, 주문 내역 대시보드, 사용자 인증(이메일/Google), 검색 기능.',
        en: 'Online store. Product listings (category filter), product detail page, cart, Stripe payment, order history dashboard, auth (email/Google), search.'
      },
      contentJsonBase: {
        navbar: { logo: 'ShopNow', links_i18n: [{ ko: '상품', en: 'Products' }, { ko: '베스트', en: 'Best Sellers' }, { ko: '고객센터', en: 'Support' }] },
        hero: { title: { ko: '특별한 쇼핑 경험', en: 'Exceptional Shopping Experience' }, subtitle: { ko: '최고의 제품을 최적의 가격으로 만나보세요', en: 'Discover the best products at the best prices' }, btn_primary: { ko: '쇼핑 시작', en: 'Start Shopping' }, btn_secondary: { ko: '베스트셀러', en: 'Best Sellers' } },
        style: { primaryColor: '#10b981', bgColor: '#0f0f0f', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }
      }
    },
    {
      id: 'blog',
      category: 'Blog',
      name: { ko: '블로그/커뮤니티', en: 'Blog / Community' },
      description: { ko: '콘텐츠 중심 블로그 또는 커뮤니티 플랫폼. 게시글 목록, 작성, 댓글 기능 포함.', en: 'Content-first blog or community platform. Post listings, editor, comments included.' },
      thumbnail: 'https://picsum.photos/seed/blog/400/250',
      prdTemplate: {
        ko: '블로그/커뮤니티 플랫폼. 게시글 목록(카테고리/태그 필터), 글 작성/수정, 댓글, 좋아요, 사용자 프로필, 인증(이메일/Google), 대시보드(내 글 관리).',
        en: 'Blog/community platform. Post listings (category/tag filter), create/edit posts, comments, likes, user profiles, auth (email/Google), dashboard (my posts).'
      },
      contentJsonBase: {
        navbar: { logo: 'DevBlog', links_i18n: [{ ko: '글 목록', en: 'Posts' }, { ko: '인기글', en: 'Popular' }, { ko: '소개', en: 'About' }] },
        hero: { title: { ko: '생각을 나누는 공간', en: 'Share Your Ideas' }, subtitle: { ko: '개발자들의 지식과 경험을 공유하세요', en: 'Share knowledge and experiences with fellow developers' }, btn_primary: { ko: '글 쓰기', en: 'Write a Post' }, btn_secondary: { ko: '인기글 보기', en: 'View Popular' } },
        style: { primaryColor: '#f59e0b', bgColor: '#0f0f0f', fontFamily: 'Georgia, "Times New Roman", serif' }
      }
    },
    {
      id: 'dashboard',
      category: 'Dashboard',
      name: { ko: '관리자 대시보드', en: 'Admin Dashboard' },
      description: { ko: '데이터 관리 및 분석 대시보드. 차트, 테이블, CRUD, 사용자 관리 포함.', en: 'Data management & analytics dashboard. Charts, tables, CRUD, user management included.' },
      thumbnail: 'https://picsum.photos/seed/dashboard/400/250',
      prdTemplate: {
        ko: '관리자 대시보드. 통계 요약 카드(매출/유저/주문), 차트(월별 추이), 데이터 테이블(검색/필터/정렬), CRUD(추가/수정/삭제), 사용자 권한 관리, 인증(이메일).',
        en: 'Admin dashboard. Summary cards (revenue/users/orders), charts (monthly trends), data tables (search/filter/sort), CRUD (add/edit/delete), user roles, auth (email).'
      },
      contentJsonBase: {
        navbar: { logo: 'AdminPanel', links_i18n: [{ ko: '대시보드', en: 'Dashboard' }, { ko: '사용자', en: 'Users' }, { ko: '설정', en: 'Settings' }] },
        hero: { title: { ko: '모든 데이터를 한눈에', en: 'All Your Data at a Glance' }, subtitle: { ko: '실시간 분석과 효율적인 관리를 위한 대시보드', en: 'Dashboard for real-time analytics and efficient management' }, btn_primary: { ko: '시작하기', en: 'Get Started' }, btn_secondary: { ko: '문서 보기', en: 'View Docs' } },
        style: { primaryColor: '#FF2D20', bgColor: '#0f0f0f', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' }
      }
    }
  ];
  res.json({ templates });
});

// ─────────────────────────────────────────────────────────────
// 터미널 명령 실행 API (16주차)
// ─────────────────────────────────────────────────────────────
app.post('/api/terminal-exec', (req, res) => {
    const { projectName, command } = req.body;
    if (!projectName || !command) {
        return res.status(400).json({ error: '입력값 누락' });
    }
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
    if (!fs.existsSync(projectPath)) {
        return res.status(404).json({ error: '프로젝트를 찾을 수 없습니다.' });
    }

    // 보안 화이트리스트
    const ALLOWED_PREFIXES = ['npm install', 'npm run build', 'npm run dev', 'npm run lint', 'npx ', 'node -v', 'npm -v', 'npm ls', 'npm outdated'];
    const cmdTrimmed = command.trim();
    const isAllowed = ALLOWED_PREFIXES.some(prefix => cmdTrimmed.startsWith(prefix));
    if (!isAllowed) {
        return res.status(403).json({ error: `허용되지 않은 명령어입니다: ${cmdTrimmed.substring(0, 30)}`, output: '' });
    }

    const npmCmd = process.platform === 'win32' ? cmdTrimmed.replace(/^npm /, 'npm.cmd ').replace(/^npx /, 'npx.cmd ') : cmdTrimmed;

    exec(npmCmd, { cwd: projectPath, timeout: 120000, maxBuffer: 1024 * 1024 * 5 }, (error, stdout, stderr) => {
        const output = (stdout || '') + (stderr || '');
        res.json({
            success: !error,
            output: output.substring(0, 5000),
            exitCode: error ? error.code || 1 : 0
        });
    });
});

// ─────────────────────────────────────────────────────────────
// 코드 버전 히스토리 API (16주차)
// ─────────────────────────────────────────────────────────────
app.get('/api/code-history/:projectName/{*filePath}', (req, res) => {
    const { projectName } = req.params;
    const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeFilePath = filePath.replace(/\.\./g, '');
    const historyDir = path.join(__dirname, 'Generated_Projects', safeName, '_history', safeFilePath);

    if (!fs.existsSync(historyDir)) {
        return res.json({ versions: [] });
    }

    try {
        const files = fs.readdirSync(historyDir)
            .filter(f => f.endsWith('.bak'))
            .sort()
            .reverse()
            .map(f => ({
                fileName: f,
                timestamp: f.replace('.bak', '').replace(/-/g, (m, offset) => offset <= 9 ? '-' : offset <= 12 ? 'T' : ':').replace(/:(\d{3})$/, '.$1Z'),
                label: f.replace('.bak', '')
            }));
        res.json({ versions: files });
    } catch (e) {
        res.json({ versions: [] });
    }
});

app.post('/api/code-rollback', (req, res) => {
    const { projectName, filePath, versionFileName } = req.body;
    if (!projectName || !filePath || !versionFileName) {
        return res.status(400).json({ error: '입력값 누락' });
    }
    const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
    const safeFilePath = filePath.replace(/\.\./g, '');
    const safeVersion = versionFileName.replace(/\.\./g, '');
    const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
    const currentFilePath = path.join(projectPath, safeFilePath);
    const historyDir = path.join(projectPath, '_history', safeFilePath);
    const backupPath = path.join(historyDir, safeVersion);

    if (!fs.existsSync(backupPath)) {
        return res.status(404).json({ error: '버전 파일을 찾을 수 없습니다.' });
    }

    try {
        // 현재 파일도 백업 후 롤백
        if (fs.existsSync(currentFilePath)) {
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const preRollbackPath = path.join(historyDir, `${timestamp}-pre-rollback.bak`);
            fs.copyFileSync(currentFilePath, preRollbackPath);
        }
        const versionContent = fs.readFileSync(backupPath, 'utf-8');
        fs.writeFileSync(currentFilePath, versionContent, 'utf-8');
        res.json({ success: true, content: versionContent });
    } catch (e) {
        res.status(500).json({ error: `롤백 실패: ${e.message}` });
    }
});

// ─────────────────────────────────────────────────────────────
// 소스코드 다운로드 API (15주차)
// ─────────────────────────────────────────────────────────────
app.get('/api/download-source/:zipName', (req, res) => {
    const { zipName } = req.params;
    const safeName = zipName.replace(/[^a-zA-Z0-9\-_.]/g, '');
    const zipPath = path.join(__dirname, 'Source_Downloads', safeName);
    if (!fs.existsSync(zipPath)) {
        return res.status(404).json({ error: 'ZIP 파일을 찾을 수 없습니다.' });
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    const stream = fs.createReadStream(zipPath);
    stream.pipe(res);
    stream.on('error', () => {
        res.status(500).json({ error: '다운로드 실패' });
    });
});
const PORT = process.env.PORT || 3002;
// ─────────────────────────────────────────────────────────────
// GitHub 양방향 동기화 API (17주차)
// ─────────────────────────────────────────────────────────────

async function githubAPI(endpoint, token, method = 'GET', body = null) {
    const options = {
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'Validatix-Engine',
        },
    };
    if (body) {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(body);
    }
    const response = await fetch(`https://api.github.com${endpoint}`, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.message || 'GitHub API error');
    return data;
}

// ── 이미지 생성 API (17주차) ──
app.post('/api/generate-image', async (req, res) => {
  try {
    const { prompt, aspectRatio, userId, lang } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }

    const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_TOKEN) {
      return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });
    }

    
    // 사용량 체크 (플랜별 이미지 생성 제한)
    if (userId) {
      const { data: usageData } = await supabaseAdmin.from('usage_limits').select('*').eq('user_id', userId).single();
      if (usageData) {
        const resetAt = new Date(usageData.reset_at);
        const now = new Date();
        if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
          await supabaseAdmin.from('usage_limits').update({ image_monthly_count: 0, reset_at: now.toISOString() }).eq('user_id', userId);
        } else {
          const plan = usageData.plan || 'free';
          const imageLimit = usageData.is_beta ? BETA_IMG_LIMIT : (plan === 'free' ? 3 : plan === 'starter' ? 15 : 999999);
          const imageCount = usageData.image_monthly_count || 0;
          if (imageCount >= imageLimit) {
            return res.status(403).json({ error: lang === 'ko' || !lang ? `이미지 생성 한도 초과 (${imageCount}/${imageLimit}). 플랜을 업그레이드해주세요.` : `Image limit reached (${imageCount}/${imageLimit}). Please upgrade your plan.` });
          }
        }
      }
    }
    // 0) 프롬프트 최적화 (한국어 → 영어 이미지 프롬프트 변환)
    let optimizedPrompt = prompt.trim();
    try {
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{ role: 'user', content: `Convert the following image description into an optimized English prompt for AI image generation (Flux model). Keep it concise (under 80 words). If already in English, just optimize it for better image generation. Do NOT include any explanation, just output the prompt only.\n\nInput: ${prompt.trim()}` }],
        }),
      });
      const claudeData = await claudeRes.json();
      if (claudeData.content?.[0]?.text) {
        optimizedPrompt = claudeData.content[0].text.trim();
        console.log(`[Image Gen] Prompt optimized: "${prompt.trim().substring(0, 30)}..." → "${optimizedPrompt.substring(0, 50)}..."`);
      }
    } catch (e) {
      console.log('[Image Gen] Prompt optimization skipped, using original');
    }
    // 1) Replicate API 호출 (Flux 1.1 Pro, sync mode)
    const replicateRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${REPLICATE_TOKEN}`,
        'Content-Type': 'application/json',
        'Prefer': 'wait',
      },
      body: JSON.stringify({
        input: {
          prompt: optimizedPrompt,
          aspect_ratio: aspectRatio || '16:9',
          output_format: 'webp',
          output_quality: 80,
        }
      })
    });

    if (!replicateRes.ok) {
      const errData = await replicateRes.json().catch(() => ({}));
      console.error('[Image Gen] Replicate API error:', replicateRes.status, errData);
      return res.status(500).json({ error: errData.detail || errData.error || 'Replicate API failed' });
    }

    const replicateData = await replicateRes.json();
    if (replicateData.status === 'failed') {
      console.error('[Image Gen] Prediction failed:', replicateData.error);
      return res.status(500).json({ error: replicateData.error || 'Image generation failed' });
    }

    // output은 URL 문자열 또는 배열
    const tempUrl = Array.isArray(replicateData.output) ? replicateData.output[0] : replicateData.output;
    if (!tempUrl) {
      return res.status(500).json({ error: 'No image output from Replicate' });
    }

    // 2) 임시 URL에서 이미지 다운로드
    const imageRes = await fetch(tempUrl);
    if (!imageRes.ok) {
      return res.status(500).json({ error: 'Failed to download generated image' });
    }
    const imageBuffer = Buffer.from(await imageRes.arrayBuffer());

    // 3) Supabase Storage에 업로드 (영구 URL)
    const fileName = `ai-generated/${userId || 'anon'}/${Date.now()}.webp`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from('images')
      .upload(fileName, imageBuffer, {
        contentType: 'image/webp',
        upsert: true,
      });

    if (uploadError) {
      console.error('[Image Gen] Supabase upload error:', uploadError);
      return res.status(500).json({ error: 'Image upload failed: ' + uploadError.message });
    }

    // 4) 공개 URL 반환
    const { data: publicUrlData } = supabaseAdmin.storage
      .from('images')
      .getPublicUrl(fileName);

    // 이미지 사용량 증가
    if (userId) {
      const { data: ud } = await supabaseAdmin.from('usage_limits').select('image_monthly_count').eq('user_id', userId).single();
      if (ud) {
        await supabaseAdmin.from('usage_limits').update({ image_monthly_count: (ud.image_monthly_count || 0) + 1 }).eq('user_id', userId);
      } else {
        await supabaseAdmin.from('usage_limits').insert({ user_id: userId, monthly_count: 0, image_monthly_count: 1, plan: 'free' });
      }
    }

    console.log(`[Image Gen] ✅ Generated: ${prompt.trim().substring(0, 50)}...`);
    res.json({
      success: true,
      imageUrl: publicUrlData.publicUrl,
      prompt: prompt.trim(),
    });

  } catch (err) {
    console.error('[Image Gen] Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});
// ── AI 이미지 일괄 교체 API (17주차) ──
app.post('/api/replace-images-batch', async (req, res) => {
  try {
    const { projectName, idea, userId } = req.body;
    if (!projectName) return res.status(400).json({ error: 'projectName required' });

    const REPLICATE_TOKEN = process.env.REPLICATE_API_TOKEN;
    if (!REPLICATE_TOKEN) return res.status(500).json({ error: 'REPLICATE_API_TOKEN not configured' });

    const projectDir = path.join(__dirname, 'Generated_Projects', projectName);
    if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

    // 1) 모든 파일에서 picsum URL 찾기
    const picRegex = /https:\/\/picsum\.photos\/seed\/[a-zA-Z0-9_-]+\/\d+\/\d+/g;
    const findings = [];

    function scanDir(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '_history') {
          scanDir(fullPath);
        } else if (entry.isFile() && /\.(tsx?|jsx?|css|html)$/.test(entry.name)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const matches = [...content.matchAll(picRegex)];
          for (const match of matches) {
            const lines = content.split('\n');
            const lineIdx = content.substring(0, match.index).split('\n').length - 1;
            const context = lines.slice(Math.max(0, lineIdx - 3), Math.min(lines.length, lineIdx + 4)).join('\n');
            findings.push({ filePath: path.relative(projectDir, fullPath), url: match[0], context: context.substring(0, 300) });
          }
        }
      }
    }
    scanDir(projectDir);

    if (findings.length === 0) return res.json({ success: true, replaced: 0, message: 'No picsum images found' });

    // 중복 URL 제거
    const uniqueUrls = [...new Set(findings.map(f => f.url))];
    const urlContextMap = {};
    for (const f of findings) { if (!urlContextMap[f.url]) urlContextMap[f.url] = f.context; }

    console.log(`[Batch Image] Found ${findings.length} picsum URLs (${uniqueUrls.length} unique)`);
    // 사용량 체크 (플랜별 이미지 생성 제한)
    if (userId) {
      const { data: usageData } = await supabaseAdmin.from('usage_limits').select('*').eq('user_id', userId).single();
      if (usageData) {
        const resetAt = new Date(usageData.reset_at);
        const now = new Date();
        if (now.getMonth() !== resetAt.getMonth() || now.getFullYear() !== resetAt.getFullYear()) {
          await supabaseAdmin.from('usage_limits').update({ image_monthly_count: 0, reset_at: now.toISOString() }).eq('user_id', userId);
        } else {
          const plan = usageData.plan || 'free';
          const imageLimit = usageData.is_beta ? BETA_IMG_LIMIT : (plan === 'free' ? 3 : plan === 'starter' ? 15 : 999999);
          const imageCount = usageData.image_monthly_count || 0;
          const remaining = imageLimit - imageCount;
          if (remaining <= 0) {
            return res.status(403).json({ error: `이미지 생성 한도 초과 (${imageCount}/${imageLimit}). 플랜을 업그레이드해주세요. / Image limit reached (${imageCount}/${imageLimit}). Please upgrade your plan.` });
          }
          if (uniqueUrls.length > remaining) {
            return res.status(403).json({ error: `Need ${uniqueUrls.length} images but only ${remaining} remaining this month. Please upgrade your plan.` });
          }
        }
      }
    }

    // 2) Claude에게 모든 이미지 프롬프트 한번에 생성
    let prompts = [];
    try {
      const contextList = uniqueUrls.map((url, i) => `Image ${i + 1} (${url}):\n${urlContextMap[url]}`).join('\n\n');
      const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{ role: 'user', content: `You are generating image prompts for an AI image generator (Flux model).

App idea: ${idea || 'web application'}

Below are ${uniqueUrls.length} placeholder images in this app. Analyze each surrounding code context, then generate an optimized English prompt for each.

RULES:
- Each prompt: 15-40 words
- All prompts must share consistent visual style (same color palette, mood, lighting)
- Modern, professional, minimalist style
- Dark theme preferred
- No text in images

Respond ONLY with a JSON array of strings. Example: ["prompt1","prompt2"]

${contextList}` }],
        }),
      });
      const claudeData = await claudeRes.json();
      const text = claudeData.content?.[0]?.text || '';
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (jsonMatch) prompts = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error('[Batch Image] Claude prompt generation failed:', e);
    }

    if (prompts.length !== uniqueUrls.length) {
      prompts = uniqueUrls.map(() => 'Modern minimalist web application illustration, dark theme, professional, abstract');
    }

    // 3) Flux로 이미지 병렬 생성 (3개씩 배치)
    const urlReplacements = {};
    const batchSize = 2;

    for (let i = 0; i < uniqueUrls.length; i += batchSize) {
      const batch = uniqueUrls.slice(i, i + batchSize);
      const batchPrompts = prompts.slice(i, i + batchSize);

      const results = await Promise.all(batch.map(async (oldUrl, j) => {
        try {
          const sizeMatch = oldUrl.match(/\/(\d+)\/(\d+)$/);
          const w = sizeMatch ? parseInt(sizeMatch[1]) : 800;
          const h = sizeMatch ? parseInt(sizeMatch[2]) : 500;
          const aspect = w >= h * 1.4 ? '16:9' : h >= w * 1.4 ? '9:16' : w > h ? '4:3' : '1:1';

          const repRes = await fetch('https://api.replicate.com/v1/models/black-forest-labs/flux-1.1-pro/predictions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${REPLICATE_TOKEN}`, 'Content-Type': 'application/json', 'Prefer': 'wait' },
            body: JSON.stringify({ input: { prompt: batchPrompts[j], aspect_ratio: aspect, output_format: 'webp', output_quality: 80 } })
          });
          if (!repRes.ok) return { oldUrl, newUrl: null };
          const repData = await repRes.json();
          const tempUrl = Array.isArray(repData.output) ? repData.output[0] : repData.output;
          if (!tempUrl) return { oldUrl, newUrl: null };

          const imgRes = await fetch(tempUrl);
          if (!imgRes.ok) return { oldUrl, newUrl: null };
          const imgBuffer = Buffer.from(await imgRes.arrayBuffer());

          const fileName = `ai-generated/${userId || 'anon'}/batch-${Date.now()}-${i + j}.webp`;
          const { error: upErr } = await supabaseAdmin.storage.from('images').upload(fileName, imgBuffer, { contentType: 'image/webp', upsert: true });
          if (upErr) return { oldUrl, newUrl: null };

          const { data: pubData } = supabaseAdmin.storage.from('images').getPublicUrl(fileName);
          console.log(`[Batch Image] ✅ ${i + j + 1}/${uniqueUrls.length}: "${batchPrompts[j].substring(0, 40)}..."`);
          return { oldUrl, newUrl: pubData.publicUrl };
        } catch (e) { return { oldUrl, newUrl: null }; }
      }));

      for (const r of results) { if (r.newUrl) urlReplacements[r.oldUrl] = r.newUrl; }
    }

    // 4) 파일에서 URL 교체
    const modifiedFiles = new Set();
    for (const finding of findings) {
      const newUrl = urlReplacements[finding.url];
      if (!newUrl) continue;
      const fullPath = path.join(projectDir, finding.filePath);
      let content = fs.readFileSync(fullPath, 'utf-8');
      if (content.includes(finding.url)) {
        content = content.split(finding.url).join(newUrl);
        fs.writeFileSync(fullPath, content, 'utf-8');
        modifiedFiles.add(finding.filePath);
      }
    }

    // 이미지 사용량 증가
    const replacedCount = Object.keys(urlReplacements).length;
    if (userId && replacedCount > 0) {
      const { data: ud } = await supabaseAdmin.from('usage_limits').select('image_monthly_count').eq('user_id', userId).single();
      if (ud) {
        await supabaseAdmin.from('usage_limits').update({ image_monthly_count: (ud.image_monthly_count || 0) + replacedCount }).eq('user_id', userId);
      } else {
        await supabaseAdmin.from('usage_limits').insert({ user_id: userId, monthly_count: 0, image_monthly_count: replacedCount, plan: 'free' });
      }
    }
    console.log(`[Batch Image] ✅ Complete: ${Object.keys(urlReplacements).length}/${uniqueUrls.length} images replaced in ${modifiedFiles.size} files`);
    res.json({ success: true, replaced: Object.keys(urlReplacements).length, totalFound: uniqueUrls.length, modifiedFiles: [...modifiedFiles] });

  } catch (err) {
    console.error('[Batch Image] Error:', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  }
});
// 1. Repo 생성
app.post('/api/github/create-repo', async (req, res) => {
    try {
        const { token, repoName, description, isPrivate } = req.body;
        if (!token || !repoName) return res.status(400).json({ error: 'token, repoName required' });

        const repo = await githubAPI('/user/repos', token, 'POST', {
            name: repoName,
            description: description || 'Created by Validatix Engine',
            private: isPrivate !== false,
            auto_init: true,
        });

        res.json({
            success: true,
            repo: {
                full_name: repo.full_name,
                html_url: repo.html_url,
                default_branch: repo.default_branch || 'main',
            }
        });
    } catch (e) {
        console.error('GitHub create-repo error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 2. Push (프로젝트 → GitHub)
app.post('/api/github/push', async (req, res) => {
    try {
        const { token, owner, repo, projectName, commitMessage } = req.body;
        if (!token || !owner || !repo || !projectName) {
            return res.status(400).json({ error: 'token, owner, repo, projectName required' });
        }

        const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
        const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
        if (!fs.existsSync(projectPath)) {
            return res.status(404).json({ error: 'Project not found' });
        }

        function collectFiles(dir, base = '') {
            let files = [];
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                const relPath = base ? `${base}/${entry.name}` : entry.name;
                if (['node_modules', '.next', '.git', '.vercel'].includes(entry.name)) continue;
                if (entry.isDirectory()) {
                    files = files.concat(collectFiles(path.join(dir, entry.name), relPath));
                } else {
                    const content = fs.readFileSync(path.join(dir, entry.name));
                    files.push({ path: relPath, content: content.toString('base64') });
                }
            }
            return files;
        }

        const files = collectFiles(projectPath);

        let latestCommitSha = null;
        let baseTreeSha = null;
        try {
            const ref = await githubAPI(`/repos/${owner}/${repo}/git/ref/heads/main`, token);
            latestCommitSha = ref.object.sha;
            const commit = await githubAPI(`/repos/${owner}/${repo}/git/commits/${latestCommitSha}`, token);
            baseTreeSha = commit.tree.sha;
        } catch (e) { /* 빈 repo */ }

        // 변경 파일만 필터링 (이전 tree와 비교)
        let existingTree = {};
        if (baseTreeSha) {
            try {
                const oldTree = await githubAPI(`/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`, token);
                for (const item of oldTree.tree) {
                    if (item.type === 'blob') existingTree[item.path] = item.sha;
                }
            } catch (e) { /* 비교 실패 시 전체 push */ }
        }

        // 변경된 파일만 blob 생성 대상으로 선별
        const filesToPush = [];
        const unchangedItems = [];
        for (const file of files) {
            const crypto = require('crypto');
            const rawContent = Buffer.from(file.content, 'base64');
            const header = `blob ${rawContent.length}\0`;
            const gitSha = crypto.createHash('sha1').update(Buffer.concat([Buffer.from(header), rawContent])).digest('hex');
            if (existingTree[file.path] && existingTree[file.path] === gitSha) {
                unchangedItems.push({ path: file.path, mode: '100644', type: 'blob', sha: gitSha });
            } else {
                filesToPush.push(file);
            }
        }

        // 10개씩 병렬로 blob 생성
        const treeItems = [...unchangedItems];
        for (let i = 0; i < filesToPush.length; i += 10) {
            const chunk = filesToPush.slice(i, i + 10);
            const results = await Promise.all(chunk.map(async (file) => {
                const blob = await githubAPI(`/repos/${owner}/${repo}/git/blobs`, token, 'POST', {
                    content: file.content,
                    encoding: 'base64',
                });
                return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
            }));
            treeItems.push(...results);
        }

        const treeBody = { tree: treeItems };
        const tree = await githubAPI(`/repos/${owner}/${repo}/git/trees`, token, 'POST', treeBody);

        const commitBody = {
            message: commitMessage || 'Update from Validatix Engine',
            tree: tree.sha,
        };
        if (latestCommitSha) commitBody.parents = [latestCommitSha];
        const newCommit = await githubAPI(`/repos/${owner}/${repo}/git/commits`, token, 'POST', commitBody);

        try {
            await githubAPI(`/repos/${owner}/${repo}/git/refs/heads/main`, token, 'PATCH', { sha: newCommit.sha });
        } catch (e) {
            await githubAPI(`/repos/${owner}/${repo}/git/refs`, token, 'POST', { ref: 'refs/heads/main', sha: newCommit.sha });
        }

        res.json({ success: true, commitSha: newCommit.sha, filesCount: files.length });
    } catch (e) {
        console.error('GitHub push error:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// 3. Pull (GitHub → 프로젝트)
app.post('/api/github/pull', async (req, res) => {
    try {
        const { token, owner, repo, projectName, syncMode } = req.body;
        if (!token || !owner || !repo || !projectName) {
            return res.status(400).json({ error: 'token, owner, repo, projectName required' });
        }

        const safeName = projectName.replace(/[^a-zA-Z0-9\-_]/g, '');
        const projectPath = path.join(__dirname, 'Generated_Projects', safeName);
        if (!fs.existsSync(projectPath)) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const ref = await githubAPI(`/repos/${owner}/${repo}/git/ref/heads/main`, token);
        const commit = await githubAPI(`/repos/${owner}/${repo}/git/commits/${ref.object.sha}`, token);
        const tree = await githubAPI(`/repos/${owner}/${repo}/git/trees/${commit.tree.sha}?recursive=1`, token);

        let updatedFiles = 0;
        for (const item of tree.tree) {
            if (item.type !== 'blob') continue;
            if (['node_modules', '.next', '.git', '.vercel'].some(skip => item.path.startsWith(skip))) continue;

            const blob = await githubAPI(`/repos/${owner}/${repo}/git/blobs/${item.sha}`, token);
            const content = Buffer.from(blob.content, 'base64');
            const filePath = path.join(projectPath, item.path);
            const dirPath = path.dirname(filePath);
            if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
            fs.writeFileSync(filePath, content);
            updatedFiles++;
        }

        // full_sync: GitHub에 없는 로컬 파일 삭제
        let deletedFiles = [];
        if (syncMode === 'full_sync') {
            const githubPaths = new Set(tree.tree.filter(i => i.type === 'blob').map(i => i.path));
            const skipDirs = ['node_modules', '.next', '.git', '.vercel'];

            function getLocalFiles(dir, base = '') {
                let localFiles = [];
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    const relPath = base ? `${base}/${entry.name}` : entry.name;
                    if (skipDirs.includes(entry.name)) continue;
                    if (entry.isDirectory()) {
                        localFiles = localFiles.concat(getLocalFiles(path.join(dir, entry.name), relPath));
                    } else {
                        localFiles.push(relPath);
                    }
                }
                return localFiles;
            }

            const localFiles = getLocalFiles(projectPath);
            for (const localFile of localFiles) {
                if (!githubPaths.has(localFile)) {
                    const fullPath = path.join(projectPath, localFile);
                    fs.unlinkSync(fullPath);
                    deletedFiles.push(localFile);
                }
            }
        }

        res.json({ success: true, updatedFiles, deletedFiles, commitSha: ref.object.sha });
    } catch (e) {
        console.error('GitHub pull error:', e.message);
        res.status(500).json({ error: e.message });
    }
});
app.listen(PORT, '0.0.0.0', () => console.log(`\n🚀 [Validatix Engine v8.2] 4주차 시장조사 자동화 완성 on port ${PORT}`));
module.exports = app;