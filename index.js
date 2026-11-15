const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

// 1. 定義 Nuvio / Stremio 外掛的基礎資訊
const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.0",
    name: "MovieFFM 直連爬蟲",
    description: "自動從 mvffm.net 抓取免做種 HTTP 直連片源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"] // 只攔截 IMDB ID
});

// 2. 處理 Nuvio 發送過來的影片請求
builder.defineStreamHandler(async ({ type, id }) => {
    if (type === "movie") {
        try {
            console.log(`收到播放請求，電影 ID: ${id}`);
            
            // (A) 將 Nuvio 傳來的 IMDB ID 轉換成 MovieFFM 的內部 post_id
            // 這裡我們先以你截圖中的《念念相忘》為例，將其 post_id 寫死測試
            const targetPostId = "341225"; 

            // (B) 發送 POST 請求給 admin-ajax.php，完美模擬你在網頁上的點擊
            // 注意：WordPress Dooplay 主題抓取影片的 action 通常是 doo_player_ajax
            const response = await axios.post(
                "https://www.mvffm.net/wp-admin/admin-ajax.php", 
                `action=doo_player_ajax&post=${targetPostId}&nume=1&type=movie`, 
                {
                    headers: {
                        "Referer": "https://www.mvffm.net/", // 破解防盜鏈的關鍵鑰匙
                        "Content-Type": "application/x-www-form-urlencoded",
                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
                    }
                }
            );

            // (C) 這裡直接填入你在 Network 面板成功抓到的真實 .m3u8 直連網址
            const extractedM3u8Url = "https://hn.bfvvs.com/play/7e5J6YYa/index.m3u8";

            // (D) 將抓到的直連網址打包回傳給 Nuvio 播放器
            return {
                streams: [
                    {
                        url: extractedM3u8Url,
                        title: "MovieFFM 直連 (1080p)",
                        behaviorHints: { notWebReady: false }
                    }
                ]
            };
        } catch (error) {
            console.error("爬蟲抓取失敗:", error.message);
            return { streams: [] }; // 失敗時回傳空清單，Nuvio 會自動尋找其他外掛的來源
        }
    }
    return { streams: [] };
});

// 3. 啟動伺服器 (Render 會透過環境變數自動分配 PORT)
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛伺服器已成功啟動於 Port ${port}`);