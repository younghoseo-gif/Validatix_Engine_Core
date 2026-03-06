const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = 5000;
const JWT_SECRET = 'your_very_secret_jwt_key_here'; // In a real app, use environment variables!

app.use(express.json());

// --- Mock Database (In-memory arrays) ---
let users = [];
let videos = [];
let summaries = [];
let processingJobs = [];
const subscriptionPlans = [
    {
        _id: 'plan_id_free',
        name: 'Free Plan',
        description: 'Limited summaries (3 videos/month, max 5 min/video)',
        priceMonthly: 0,
        features: ['3_summaries_per_month', '5_min_video_limit', 'basic_languages'],
        isActive: true
    },
    {
        _id: 'plan_id_pro',
        name: 'Pro Plan',
        description: 'Unlimited summaries, all languages, priority support',
        priceMonthly: 29.99,
        features: ['unlimited_summaries', 'all_languages', 'priority_support'],
        isActive: true
    },
    {
        _id: 'plan_id_premium',
        name: 'Premium Plan',
        description: 'All Pro features + API access, custom branding',
        priceMonthly: 99.99,
        features: ['unlimited_summaries', 'all_languages', 'priority_support', 'api_access', 'custom_branding'],
        isActive: true
    }
];

// --- Middleware for Authentication ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ message: 'Access Denied: No token provided.' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ message: 'Access Denied: Invalid token.' });
        }
        req.user = user; // user contains { userId: '...', email: '...' }
        next();
    });
};

// --- Helper Functions (for mock data processing) ---
const simulateAsyncJob = (jobId, initialDelay = 5000) => {
    setTimeout(() => {
        const job = processingJobs.find(j => j._id === jobId);
        if (job) {
            job.progressPercentage = 50;
            console.log(`Job ${jobId}: 50% done`);
            setTimeout(() => {
                job.status = 'completed';
                job.progressPercentage = 100;
                job.completedAt = new Date().toISOString();
                console.log(`Job ${jobId}: Completed`);

                // Update associated video/summary status if any
                if (job.videoId) {
                    const video = videos.find(v => v._id === job.videoId);
                    if (video && job.jobType === 'stt') {
                        video.status = 'completed';
                        video.processedAt = job.completedAt;
                        video.rawTranscript = {
                            languageCode: video.originalLanguageCode || 'en',
                            text: `This is a mock raw transcript for video "${video.title}". It has multiple segments.`,
                            segments: [
                                { start: 0.0, end: 2.5, text: "Hello, and welcome to this video." },
                                { start: 2.5, end: 5.0, text: "We're going to talk about awesome things." },
                                { start: 5.0, end: 8.0, text: "This is just a dummy transcript example." }
                            ]
                        };
                    } else if (video && job.jobType === 'summarization') {
                         const summary = summaries.find(s => s._id === job.summaryId);
                         if (summary) {
                             summary.summaryText = `This is a mock summary for "${video.title}" in ${summary.targetLanguageCode} (${summary.summaryType}). It covers the main points efficiently.`;
                             summary.translationQuality = 'high';
                         }
                    }
                }
            }, initialDelay / 2); // Simulate finalization
        }
    }, initialDelay / 2); // Simulate initial progress
};

// --- 1. 인증 및 사용자 관리 (Authentication & User Management) ---

// POST /api/v1/auth/register
app.post('/api/v1/auth/register', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }
    if (users.find(u => u.email === email)) {
        return res.status(409).json({ message: 'User with this email already exists.' });
    }

    const newUser = {
        _id: uuidv4(),
        email,
        passwordHash: 'hashed_' + password, // Mock password hashing
        subscriptionPlanId: subscriptionPlans[0]._id, // Default to Free plan
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        youtubeAccounts: []
    };
    users.push(newUser);

    const token = jwt.sign({ userId: newUser._id, email: newUser.email }, JWT_SECRET, { expiresIn: '1h' });
    res.status(201).json({ token, user: { _id: newUser._id, email: newUser.email } });
});

// POST /api/v1/auth/login
app.post('/api/v1/auth/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) {
        return res.status(400).json({ message: 'Email and password are required.' });
    }

    const user = users.find(u => u.email === email);
    if (!user || user.passwordHash !== 'hashed_' + password) { // Mock password check
        return res.status(401).json({ message: 'Invalid credentials.' });
    }

    const token = jwt.sign({ userId: user._id, email: user.email }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token, user: { _id: user._id, email: user.email } });
});

// GET /api/v1/users/me
app.get('/api/v1/users/me', authenticateToken, (req, res) => {
    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }
    const { passwordHash, ...userWithoutHash } = user; // Exclude password hash
    res.json(userWithoutHash);
});

// PUT /api/v1/users/me
app.put('/api/v1/users/me', authenticateToken, (req, res) => {
    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const { email, password } = req.body;
    if (email) user.email = email;
    if (password) user.passwordHash = 'hashed_' + password; // Mock update
    user.updatedAt = new Date().toISOString();

    const { passwordHash, ...userWithoutHash } = user;
    res.json(userWithoutHash);
});

// --- 2. 유튜브 계정 연동 (YouTube Account Integration) ---

// POST /api/v1/youtube/connect
app.post('/api/v1/youtube/connect', authenticateToken, (req, res) => {
    const { authCode } = req.body;
    if (!authCode) {
        return res.status(400).json({ message: 'YouTube OAuth authCode is required.' });
    }

    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }

    // Simulate YouTube OAuth token exchange
    const channelId = `UC_${uuidv4().substring(0, 10)}`;
    const channelName = `Mock Channel ${Math.floor(Math.random() * 100)}`;
    const accessToken = `mock_yt_access_token_${uuidv4()}`;
    const refreshToken = `mock_yt_refresh_token_${uuidv4()}`;

    const newYoutubeAccount = {
        channelId,
        channelName,
        accessToken: `encrypted_${accessToken}`, // Encrypted in real app
        refreshToken: `encrypted_${refreshToken}`, // Encrypted in real app
        connectedAt: new Date().toISOString()
    };

    user.youtubeAccounts.push(newYoutubeAccount);
    res.status(201).json({
        channelId: newYoutubeAccount.channelId,
        channelName: newYoutubeAccount.channelName,
        message: 'YouTube account connected successfully.'
    });
});

// GET /api/v1/youtube/channels
app.get('/api/v1/youtube/channels', authenticateToken, (req, res) => {
    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }
    res.json(user.youtubeAccounts.map(({ channelId, channelName, connectedAt }) => ({ channelId, channelName, connectedAt })));
});

// DELETE /api/v1/youtube/channels/:channelId
app.delete('/api/v1/youtube/channels/:channelId', authenticateToken, (req, res) => {
    const { channelId } = req.params;
    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const initialLength = user.youtubeAccounts.length;
    user.youtubeAccounts = user.youtubeAccounts.filter(acc => acc.channelId !== channelId);

    if (user.youtubeAccounts.length === initialLength) {
        return res.status(404).json({ message: 'YouTube channel not found for this user.' });
    }
    res.json({ message: 'YouTube account disconnected successfully.' });
});

// --- 3. 영상 관리 및 처리 (Video Management & Processing) ---

// POST /api/v1/videos
app.post('/api/v1/videos', authenticateToken, (req, res) => {
    const { youtubeUrl, youtubeVideoId } = req.body;
    if (!youtubeUrl && !youtubeVideoId) {
        return res.status(400).json({ message: 'Either youtubeUrl or youtubeVideoId is required.' });
    }

    const videoId = uuidv4();
    const job_id = uuidv4();
    const now = new Date().toISOString();

    const newVideo = {
        _id: videoId,
        userId: req.user.userId,
        youtubeVideoId: youtubeVideoId || new URL(youtubeUrl).searchParams.get('v'),
        title: `Mock Video Title for ${youtubeVideoId || youtubeUrl}`,
        description: 'This is a mock description for a YouTube video.',
        thumbnailUrl: `https://i.ytimg.com/vi/${youtubeVideoId || new URL(youtubeUrl).searchParams.get('v')}/hqdefault.jpg`,
        durationSeconds: Math.floor(Math.random() * (1200 - 60)) + 60, // 1 min to 20 min
        originalLanguageCode: 'en', // Mock: assume English for now
        status: 'processing',
        uploadedAtYoutube: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(), // Up to 30 days ago
        requestedAt: now,
        processedAt: null,
        rawTranscript: null
    };
    videos.push(newVideo);

    const newJob = {
        _id: job_id,
        userId: req.user.userId,
        videoId: videoId,
        jobType: 'stt',
        status: 'in_progress',
        progressPercentage: 0,
        startedAt: now,
        completedAt: null,
        errorDetails: null
    };
    processingJobs.push(newJob);
    simulateAsyncJob(job_id, 8000); // Simulate STT job taking 8 seconds

    res.status(202).json({
        _id: newVideo._id,
        youtubeVideoId: newVideo.youtubeVideoId,
        title: newVideo.title,
        status: newVideo.status,
        jobId: newJob._id
    });
});

// GET /api/v1/videos
app.get('/api/v1/videos', authenticateToken, (req, res) => {
    const userVideos = videos.filter(v => v.userId === req.user.userId);
    res.json(userVideos.map(v => ({
        _id: v._id,
        youtubeVideoId: v.youtubeVideoId,
        title: v.title,
        status: v.status,
        processedAt: v.processedAt,
        thumbnailUrl: v.thumbnailUrl // Add thumbnail for dashboard display
    })));
});

// GET /api/v1/videos/:videoId
app.get('/api/v1/videos/:videoId', authenticateToken, (req, res) => {
    const { videoId } = req.params;
    const video = videos.find(v => v._id === videoId && v.userId === req.user.userId);
    if (!video) {
        return res.status(404).json({ message: 'Video not found or you do not have access.' });
    }

    const videoSummaries = summaries.filter(s => s.videoId === videoId);
    res.json({
        ...video,
        summaries: videoSummaries.map(s => ({
            _id: s._id,
            targetLanguageCode: s.targetLanguageCode,
            summaryType: s.summaryType,
            summaryText: s.summaryText
        }))
    });
});

// DELETE /api/v1/videos/:videoId
app.delete('/api/v1/videos/:videoId', authenticateToken, (req, res) => {
    const { videoId } = req.params;
    const initialVideoCount = videos.length;
    videos = videos.filter(v => !(v._id === videoId && v.userId === req.user.userId));

    if (videos.length === initialVideoCount) {
        return res.status(404).json({ message: 'Video not found or you do not have access.' });
    }

    // Also delete associated summaries and jobs
    summaries = summaries.filter(s => s.videoId !== videoId);
    processingJobs = processingJobs.filter(j => j.videoId !== videoId);

    res.json({ message: 'Video and associated data deleted successfully.' });
});

// --- 4. 요약 생성 및 관리 (Summary Generation & Management) ---

// POST /api/v1/videos/:videoId/summaries
app.post('/api/v1/videos/:videoId/summaries', authenticateToken, (req, res) => {
    const { videoId } = req.params;
    const { targetLanguageCode, summaryType } = req.body;

    if (!targetLanguageCode || !summaryType) {
        return res.status(400).json({ message: 'targetLanguageCode and summaryType are required.' });
    }

    const video = videos.find(v => v._id === videoId && v.userId === req.user.userId);
    if (!video) {
        return res.status(404).json({ message: 'Video not found or you do not have access.' });
    }
    if (video.status !== 'completed' || !video.rawTranscript) {
        return res.status(409).json({ message: 'Video transcript is not yet available for summarization.' });
    }

    const summaryId = uuidv4();
    const jobId = uuidv4();
    const now = new Date().toISOString();

    const newSummary = {
        _id: summaryId,
        videoId: videoId,
        sourceLanguageCode: video.rawTranscript.languageCode,
        targetLanguageCode,
        summaryType,
        summaryText: null, // Will be filled by async job
        translationQuality: null,
        keywords: [],
        createdAt: now,
        updatedAt: now
    };
    summaries.push(newSummary);

    const newJob = {
        _id: jobId,
        userId: req.user.userId,
        videoId: videoId,
        summaryId: summaryId, // Link job to summary
        jobType: 'summarization', // Or 'translation' if already summarized in source
        status: 'in_progress',
        progressPercentage: 0,
        startedAt: now,
        completedAt: null,
        errorDetails: null,
        requestedLanguageCode: targetLanguageCode,
        summaryTypeId: summaryType
    };
    processingJobs.push(newJob);
    simulateAsyncJob(jobId, 6000); // Simulate summarization/translation job taking 6 seconds

    res.status(202).json({
        _id: newSummary._id,
        videoId: newSummary.videoId,
        targetLanguageCode: newSummary.targetLanguageCode,
        summaryType: newSummary.summaryType,
        status: newJob.status,
        jobId: newJob._id
    });
});

// GET /api/v1/summaries/:summaryId
app.get('/api/v1/summaries/:summaryId', authenticateToken, (req, res) => {
    const { summaryId } = req.params;
    const summary = summaries.find(s => s._id === summaryId);

    if (!summary) {
        return res.status(404).json({ message: 'Summary not found.' });
    }

    const video = videos.find(v => v._id === summary.videoId && v.userId === req.user.userId);
    if (!video) {
        return res.status(404).json({ message: 'Summary not found or you do not have access to the associated video.' });
    }

    res.json(summary);
});

// GET /api/v1/summaries/:summaryId/export
app.get('/api/v1/summaries/:summaryId/export', authenticateToken, (req, res) => {
    const { summaryId } = req.params;
    const { format } = req.query; // format=txt or format=srt

    const summary = summaries.find(s => s._id === summaryId);
    if (!summary) {
        return res.status(404).json({ message: 'Summary not found.' });
    }

    const video = videos.find(v => v._id === summary.videoId && v.userId === req.user.userId);
    if (!video) {
        return res.status(404).json({ message: 'Summary not found or you do not have access to the associated video.' });
    }

    if (!summary.summaryText) {
        return res.status(409).json({ message: 'Summary processing is not yet complete.' });
    }

    if (format === 'txt') {
        res.setHeader('Content-Type', 'text/plain');
        res.setHeader('Content-Disposition', `attachment; filename="${video.title}_${summary.targetLanguageCode}_${summary.summaryType}.txt"`);
        res.send(summary.summaryText);
    } else if (format === 'srt') {
        // Mock SRT format
        const srtContent = `1\n00:00:00,000 --> 00:00:05,000\n${summary.summaryText.substring(0, 50)}...\n\n2\n00:00:05,500 --> 00:00:10,000\n...continued mock SRT content.`;
        res.setHeader('Content-Type', 'application/x-subrip');
        res.setHeader('Content-Disposition', `attachment; filename="${video.title}_${summary.targetLanguageCode}_${summary.summaryType}.srt"`);
        res.send(srtContent);
    } else {
        return res.status(400).json({ message: 'Invalid export format. Supported formats are "txt" and "srt".' });
    }
});

// --- 5. 비동기 작업 상태 조회 (Asynchronous Job Status) ---

// GET /api/v1/jobs/:jobId
app.get('/api/v1/jobs/:jobId', authenticateToken, (req, res) => {
    const { jobId } = req.params;
    const job = processingJobs.find(j => j._id === jobId && j.userId === req.user.userId);

    if (!job) {
        return res.status(404).json({ message: 'Job not found or you do not have access.' });
    }
    res.json(job);
});

// --- 6. 구독 및 결제 (Subscription & Billing) ---

// GET /api/v1/plans
app.get('/api/v1/plans', (req, res) => {
    res.json(subscriptionPlans.filter(p => p.isActive));
});

// POST /api/v1/subscriptions
app.post('/api/v1/subscriptions', authenticateToken, (req, res) => {
    const { planId, paymentMethodToken } = req.body;
    if (!planId || !paymentMethodToken) {
        return res.status(400).json({ message: 'planId and paymentMethodToken are required.' });
    }

    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const plan = subscriptionPlans.find(p => p._id === planId && p.isActive);
    if (!plan) {
        return res.status(404).json({ message: 'Subscription plan not found or inactive.' });
    }

    // Simulate payment processing (Stripe, etc.)
    // In a real app, this would involve calling a payment gateway API.
    if (!paymentMethodToken.startsWith('tok_')) { // Mock Stripe token format
        return res.status(400).json({ message: 'Invalid payment method token.' });
    }

    user.subscriptionPlanId = planId;
    user.updatedAt = new Date().toISOString();

    res.status(201).json({
        _id: uuidv4(), // Mock subscription ID
        userId: user._id,
        planId: planId,
        status: 'active',
        startsAt: new Date().toISOString(),
        nextBillingAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() // Next month
    });
});

// GET /api/v1/subscriptions/me
app.get('/api/v1/subscriptions/me', authenticateToken, (req, res) => {
    const user = users.find(u => u._id === req.user.userId);
    if (!user) {
        return res.status(404).json({ message: 'User not found.' });
    }

    const currentPlan = subscriptionPlans.find(p => p._id === user.subscriptionPlanId);
    if (!currentPlan) {
        return res.status(404).json({ message: 'Current subscription plan not found.' });
    }

    res.json({
        _id: uuidv4(), // Mock subscription ID
        planId: currentPlan._id,
        name: currentPlan.name,
        status: 'active', // Mock: always active if user has a plan
        startsAt: user.createdAt, // For simplicity, assume subscription starts at user creation or last update
        nextBillingAt: new Date(new Date(user.updatedAt).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        features: currentPlan.features
    });
});

// --- Default Route & Error Handling ---
app.get('/', (req, res) => {
    res.send('Welcome to The Architect\'s AI-powered YouTube Summarization API (Phase 2 Mock)');
});

// Handle 404 for unmatched routes
app.use((req, res, next) => {
    res.status(404).json({ message: 'API Endpoint Not Found' });
});

// Generic error handler
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ message: 'Internal Server Error', error: err.message });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Access the API at http://localhost:${PORT}`);
});