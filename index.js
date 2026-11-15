require('dotenv').config();
const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.0",
    name: "MovieFFM 自動爬蟲",
    description: "自動從 mvffm.net 搜尋並抓取直連片源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"] // 攔截 Nuvio 傳來的 IMDB ID
});

// 模擬瀏覽器的防護標頭 (Headers)
const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.mvffm.net/" // 繞過防盜鏈的核心
};

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 播放請求，IMDB ID: ${id}`);
        
        // 1. 取得電影名稱 (華語片需中文名才能在網站搜尋成功)
        let movieTitle = "";
        
        // 如果你在 Render 環境變數有設定之前的 TMDB_API_KEY，優先用它抓精準中文名
        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl);
            movieTitle = tmdbRes.data.movie_results?.[0]?.title;
        }
        
        // 若沒設定 TMDB，退回使用官方 Cinemeta 抓取預設名稱
        if (!movieTitle) {
            const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            movieTitle = metaRes.data?.meta?.name;
        }
        if (!movieTitle) throw new Error("無法解析電影名稱");
        console.log(`[2] 準備搜尋電影: ${movieTitle}`);

        // 2. 去 MovieFFM 執行搜尋
        const searchUrl = `https://www.mvffm.net/?s=${encodeURIComponent(movieTitle)}`;
        const searchRes = await axios.get(searchUrl, { headers });
        
        // 3. 用正則表達式從網頁原始碼挖出真正的 post_id (通常藏在 <article id="post-12345">)
        const postIdMatch = searchRes.data.match(/id="post-(\d+)"/);
        if (!postIdMatch) throw new Error("網站上找不到這部電影的對應 post_id");
        const postId = postIdMatch[1];
        console.log(`[3] 找到目標 post_id: ${postId}`);

        // 4. 發送我們在 Network 面板抓到的 admin-ajax API 請求
        const ajaxRes = await axios.post(
            "https://www.mvffm.net/wp-admin/admin-ajax.php", 
            `action=doo_player_ajax&post=${postId}&nume=1&type=movie`, // 預設先抓第一個片源 (nume=1)
            {
                headers: {
                    ...headers,
                    "Content-Type": "application/x-www-form-urlencoded"
                }
            }
        );

        // 5. 從 API 回傳的資料中提取最終的 m3u8 直連網址
        let streamUrl = "";
        const responseData = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        
        // 嘗試直接抓 m3u8
        const m3u8Match = responseData.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/);
        if (m3u8Match) {
            streamUrl = m3u8Match[1];
        } else {
            // 若 API 吐出的是 iframe，則進一步去 iframe 網頁裡面挖 m3u8
            const iframeMatch = responseData.match(/src=["']?\\?(https?:\/\/[^"'\\]+)["']?/);
            if (iframeMatch) {
                let iframeUrl = iframeMatch[1].replace(/\\\//g, '/'); // 處理 JSON 脫逸斜線
                console.log(`[4] 發現 iframe 網址，準備深入解析: ${iframeUrl}`);
                const iframeRes = await axios.get(iframeUrl, { headers });
                const deepM3u8 = iframeRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8)/);
                if (deepM3u8) streamUrl = deepM3u8[1];
            }
        }

        if (!streamUrl) throw new Error("無法成功解析出 m3u8 播放網址");
        console.log(`[5] 成功提取最終播放網址: ${streamUrl}`);

        // 6. 將整理好的網址送回給 Nuvio 播放器
        return {
            streams: [
                {
                    url: streamUrl,
                    title: `MovieFFM 直連\n(自動解析)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        console.error("外掛執行錯誤:", error.message);
        return { streams: [] };
    }
});

// 啟動伺服器
const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛伺服器已成功啟動於 Port ${port}`);
