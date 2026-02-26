// v1.5 - 2026-02-14 15:30 (Asia/Taipei)
// 修改內容: 未知瀏覽器改為「未分類」、自動提取網站名稱、擴充遊戲/工作關鍵字

class ClassifierService {
    constructor(configManager) {
        this.configManager = configManager;

        // 分類規則
        this.rules = {
            // ========== 工作類應用程式 ==========
            work: [
                // 設計軟體
                'AutoCAD', 'SketchUp', '3ds Max', 'Rhino', 'Revit', 'ArchiCAD',
                'Photoshop', 'Illustrator', 'InDesign', 'Lightroom', 'Premiere', 'After Effects',
                'CorelDRAW', 'GIMP', 'Inkscape', 'Figma', 'Sketch', 'Adobe XD',
                'Blender', 'Cinema 4D', 'Maya', 'ZBrush', 'V-Ray', 'Enscape',

                // Office 軟體
                'Microsoft Word', 'Microsoft Excel', 'Microsoft PowerPoint',
                'Microsoft Outlook', 'Microsoft OneNote', 'Microsoft Teams',
                'Word', 'Excel', 'PowerPoint', 'Outlook', 'OneNote', 'Teams',
                'LibreOffice', 'WPS Office',

                // 通訊軟體（視為工作用）
                'LINE', 'LINE WORKS', 'Slack', 'Discord',

                // 開發工具 / AI 助手
                'Visual Studio', 'VS Code', 'Code', 'Notepad++', 'Sublime Text',
                'IntelliJ', 'WebStorm', 'PyCharm', 'Android Studio',
                'Antigravity', 'Cursor', 'GitHub Desktop', 'Git',
                'Terminal', 'PowerShell', 'cmd', 'Windows Terminal',
                'Electron',

                // 遠端桌面 / 協作工具
                'Splashtop', 'TeamViewer', 'AnyDesk', 'Remote Desktop',
                'Zoom', 'Google Meet', 'Webex', 'Skype',

                // 檔案管理
                'File Explorer', '檔案總管', 'Windows Explorer', 'Explorer',
                'Dropbox', 'Google Drive', 'OneDrive',

                // 專案管理
                'Trello', 'Asana', 'Notion', 'Jira', 'Monday', 'ClickUp',

                // PDF 閱讀
                'Adobe Acrobat', 'Foxit Reader', 'PDF-XChange',

                // 系統工具（視為工作）
                'Task Manager', '工作管理員', 'Settings', '設定'
            ],

            // ========== 音樂類（背景播放不影響工作）==========
            music: [
                'Spotify', 'KKBOX', 'Apple Music', 'YouTube Music',
                'iTunes', 'Foobar2000', 'AIMP', 'MusicBee', 'Winamp',
                'SoundCloud', 'Tidal', 'Deezer', 'Amazon Music'
            ],

            // 音樂關鍵字（用於瀏覽器標題匹配）
            musicKeywords: [
                'YouTube Music', 'Spotify', 'KKBOX', 'SoundCloud',
                '音樂', 'Music', 'playlist', '播放清單',
                'Podcast', '廣播'
            ],

            // ========== 影片類 ==========
            videoKeywords: [
                'YouTube', 'Netflix', 'Disney+', '愛奇藝', 'friDay影音',
                'LINE TV', 'KKTV', 'CatchPlay', 'HBO GO', 'Apple TV',
                'Twitch', '直播', 'Live', 'bilibili', 'B站',
                '動畫瘋', 'Crunchyroll', 'Ani-One'
            ],

            // ========== 社群類 ==========
            socialKeywords: [
                'Facebook', 'Instagram', 'Twitter', 'Threads', 'TikTok',
                'PTT', 'Dcard', '巴哈姆特', '論壇',
                'Messenger', 'WhatsApp', 'Telegram',
                'LinkedIn', 'Reddit'
            ],

            // ========== 購物類 ==========
            shoppingKeywords: [
                'PChome', '蝦皮', 'momo購物', 'Yahoo購物',
                '博客來', '誠品', 'Amazon', '淘寶', '天貓',
                'Costco', '家樂福', '全聯', '7-ELEVEN',
                '露天', '樂天', 'IKEA'
            ],

            // ========== 遊戲類 ==========
            games: [
                'Steam', 'Epic Games', 'Origin', 'Uplay', 'Battle.net',
                'Xbox', 'PlayStation', 'GOG Galaxy',
                'League of Legends', 'VALORANT', 'Minecraft', 'Fortnite',
                'Counter-Strike', 'Apex Legends', 'Genshin Impact',
                'Overwatch', 'Diablo', 'World of Warcraft'
            ],

            gameKeywords: [
                '遊戲', 'Game', 'Gaming', 'Steam', 'Epic',
                // 遊戲百科/攻略網站
                'wiki', '維基', '攻略', '灰機', 'fandom',
                'gamepedia', 'NGA', '遊戲基地', 'gamebase',
                // 常見遊戲名稱
                '幻想', 'FFXIV', 'FF14', '原神', '崩壞', '明日方舟',
                '英雄聯盟', 'LOL', '魔獸', '暗黑', '鬥陣特攻',
                'Minecraft', 'PUBG', '絕地求生', '傳說對決',
                '荒野亂鬥', '第五人格', 'Roblox'
            ],

            // ========== 工作網頁關鍵字（瀏覽器中判斷用）==========
            workWebKeywords: [
                // Google 工作套件
                'Google 試算表', 'Google 文件', 'Google 簡報', 'Google 表單',
                'Google Sheets', 'Google Docs', 'Google Slides', 'Google Forms',
                'Google Calendar', 'Google 日曆', 'Gmail',
                'Google Maps', 'Google 地圖',

                // 室內裝修相關
                '報價', '估價', '工程', '裝修', '裝潢', '設計',
                '施工', '材料', '建材', '五金', '系統櫃',
                '木工', '水電', '泥作', '油漆',

                // 雲端/工作工具
                'Notion', 'Trello', 'Jira', 'Asana',
                'GitHub', 'GitLab', 'Stack Overflow', 'stackoverflow',
                'Confluence', 'Slack',

                // 技術文件
                'MDN', 'W3Schools', 'developer', 'documentation',
                'API', 'npm', 'tutorial',

                // 政府/商業
                '國稅局', '勞動部', '營建署', '內政部',
                '電子發票', '統一編號', '公司登記',

                // 打卡/管理系統
                '打卡', '出勤', '考勤', '排班', '班表'
            ]
        };

        // 載入使用者已學習的自訂規則
        this.loadCustomRules();

        console.log('[Classifier] 分類服務已初始化（含網頁內容細分與未分類收集）');
    }

    // 載入自訂規則
    loadCustomRules() {
        try {
            const customRules = this.configManager.get('classificationRules');
            if (customRules) {
                // [v2.2.8] 改為合併而非直接覆蓋，確保新版預設規則能生效
                for (const [category, newRules] of Object.entries(customRules)) {
                    if (this.rules[category] && Array.isArray(newRules)) {
                        // 使用 Set 確保不重複
                        const combined = new Set([...this.rules[category], ...newRules]);
                        this.rules[category] = Array.from(combined);
                    } else {
                        this.rules[category] = newRules;
                    }
                }
                console.log('[Classifier] 已智慧合併自訂分類規則');
            }
        } catch (error) {
            console.error('[Classifier] 載入自訂規則失敗:', error.message);
        }
    }

    // 分類應用程式（回傳主分類）
    classify(appName, windowTitle) {
        const result = this.classifyDetailed(appName, windowTitle);
        return result.category;
    }

    // 詳細分類（回傳 category、subCategory、label、siteName）
    classifyDetailed(appName, windowTitle) {
        const appNameLower = (appName || '').toLowerCase();
        const windowTitleLower = (windowTitle || '').toLowerCase();

        // [v2.2.8] 核心工作軟體優先判定 (防止被誤歸類為休閒/其他)
        const coreWorkApps = ['antigravity', 'explorer', '檔案總管'];
        if (coreWorkApps.some(kw => appNameLower.includes(kw) || windowTitleLower.includes(kw))) {
            return { category: 'work', subCategory: 'app', label: '💼 工作' };
        }

        // 1. 先檢查是否為遊戲應用程式
        if (this.matchList(appNameLower, this.rules.games)) {
            return { category: 'leisure', subCategory: 'game', label: '🎮 遊戲' };
        }

        // 2. 檢查是否為瀏覽器
        const browsers = ['chrome', 'edge', 'firefox', 'opera', 'brave', 'safari'];
        const isBrowser = browsers.some(b => appNameLower.includes(b));

        if (isBrowser) {
            // 提取網站名稱（用於顯示和未分類記錄）
            const siteName = this.extractSiteName(windowTitle || '');

            // 2.1 遊戲（優先！因為可能在瀏覽器裡看遊戲 wiki）
            if (this.matchKeywords(windowTitleLower, this.rules.gameKeywords)) {
                return { category: 'leisure', subCategory: 'game', label: '🎮 遊戲', siteName };
            }

            // 2.2 音樂
            if (this.matchKeywords(windowTitleLower, this.rules.musicKeywords)) {
                return { category: 'leisure', subCategory: 'music', label: '🎵 音樂', siteName };
            }

            // 2.3 影片
            if (this.matchKeywords(windowTitleLower, this.rules.videoKeywords)) {
                return { category: 'leisure', subCategory: 'video', label: '🎬 影片', siteName };
            }

            // 2.4 社群
            if (this.matchKeywords(windowTitleLower, this.rules.socialKeywords)) {
                return { category: 'leisure', subCategory: 'social', label: '📱 社群', siteName };
            }

            // 2.5 購物
            if (this.matchKeywords(windowTitleLower, this.rules.shoppingKeywords)) {
                return { category: 'leisure', subCategory: 'shopping', label: '🛒 購物', siteName };
            }

            // 2.6 工作網頁（有明確工作關鍵字）
            if (this.matchKeywords(windowTitleLower, this.rules.workWebKeywords)) {
                return { category: 'work', subCategory: 'browser', label: '🌐 工作網頁', siteName };
            }

            // 2.7 都不符合 → 標記為「未分類」
            return { category: 'other', subCategory: 'unclassified', label: '❓ 未分類', siteName };
        }

        // 3. 檢查音樂播放器（前景時視為休閒）
        if (this.matchList(appNameLower, this.rules.music)) {
            return { category: 'leisure', subCategory: 'music', label: '🎵 音樂' };
        }

        // 4. 檢查工作類應用程式
        if (this.matchList(appNameLower, this.rules.work)) {
            return { category: 'work', subCategory: 'app', label: '💼 工作' };
        }

        // 5. 無法分類的應用程式
        return { category: 'other', subCategory: 'unknown', label: '❓ 其他' };
    }

    // 從瀏覽器視窗標題中提取顯示名稱
    // 只移除瀏覽器名稱後綴，保留完整標題以便辨識
    extractSiteName(windowTitle) {
        if (!windowTitle) return '';

        let cleaned = windowTitle
            .replace(/ - Google Chrome$/i, '')
            .replace(/ - Microsoft Edge$/i, '')
            .replace(/ - 個人 - Microsoft Edge$/i, '')
            .replace(/ - 工作 - Microsoft Edge$/i, '')
            .replace(/ - Firefox$/i, '')
            .replace(/ - Opera$/i, '')
            .replace(/ - Opera GX$/i, '')
            .replace(/ - Brave$/i, '')
            .replace(/ - Vivaldi$/i, '')
            .replace(/ - Internet Explorer$/i, '')
            .trim();

        // 截取前 30 字（報告中可讀性足夠）
        if (cleaned.length > 30) {
            cleaned = cleaned.substring(0, 30) + '…';
        }

        return cleaned;
    }

    // 匹配清單
    matchList(text, list) {
        if (!list) return false;
        return list.some(item => text.includes(item.toLowerCase()));
    }

    // 匹配關鍵字
    matchKeywords(text, keywords) {
        if (!keywords) return false;
        return keywords.some(kw => text.includes(kw.toLowerCase()));
    }

    // 取得所有分類規則（供 UI 顯示）
    getRules() {
        return this.rules;
    }

    // 更新自訂規則
    updateCustomRules(rules) {
        Object.assign(this.rules, rules);
        this.configManager.set('classificationRules', rules);
        console.log('[Classifier] 自訂分類規則已更新');
    }
}

module.exports = { ClassifierService };
