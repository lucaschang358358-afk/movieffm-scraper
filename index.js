const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.3",
    name: "MovieFFM 直連外掛 (雙重搜尋版)",
    description: "自動轉換中文片名，若失敗則退回英文搜尋，並透過 Scraper API 繞過防護",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.mvffm.net/"
};

async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    if (!process.env.SCRAPER_API_KEY) {
        return axios({ method, url: targetUrl, data: payload, headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders });
    }
    return axios({
        method: method,
        url: "http://api.scraperapi.com",
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl,
            keep_headers: "true",
            premium: "true"
        },
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
    });
}

// 輔助函數：執行搜尋並挖出 post_id
async function searchMovieAndGetPostId(title) {
    console.log(`準備搜尋片名: ${title}`);
    const searchTargetUrl = `https://www.mvffm.net/?s=${encodeURIComponent(title)}`;
    const searchRes = await fetchViaScraper(searchTargetUrl, "GET");
    
    const postIdMatch = searchRes.data.match(/id="post-(\d+)"/);
    if (postIdMatch) {
        return postIdMatch[1]; // 成功找到 post_id
    }
    return null; // 找不到
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        let tmdbTitle = "";
        let cinemetaTitle = "";

        // 1. 取得 TMDB 中文譯名
        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl);
            tmdbTitle = tmdbRes.data.movie_results?.[0]?.title || tmdbRes.data.tv_results?.[0]?.name;
        }
        
        // 2. 取得 Cinemeta 英文原名 (預設備案)
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
        cinemetaTitle = metaRes.data?.meta?.name;

        if (!tmdbTitle && !cinemetaTitle) throw new Error("無法解析電影名稱");

        // --- 階段 B: 雙重搜尋保險 ---
        let postId = null;
        
        // 優先用中文搜
        if (tmdbTitle) {
            console.log(`[2A] 優先使用中文搜尋...`);
            postId = await searchMovieAndGetPostId(tmdbTitle);
        }

        // 如果中文搜不到，退回用英文搜
        if (!postId && cinemetaTitle && cinemetaTitle !== tmdbTitle) {
            console.log(`[2B] 中文搜不到，退回使用英文搜尋...`);
            postId = await searchMovieAndGetPostId(cinemetaTitle);
        }

        if (!postId) throw new Error("中文與英文片名皆無法在網站上找到該電影");
        console.log(`[3] 成功挖出內部 post_id: ${postId}`);

        // --- 階段 C: 觸發 admin-ajax.php 取得影片資料 ---
        const ajaxTargetUrl = "https://www.mvffm.net/wp-admin/admin-ajax.php";
        const ajaxPayload = `action=doo_player_ajax&post=${postId}&nume=1&type=movie`;
        const ajaxRes = await fetchViaScraper(ajaxTargetUrl, "POST", ajaxPayload);

        // --- 階段 D: 解析最終的 m3u8 直連網址 ---
        let streamUrl = "";
        const responseData = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        
        const m3u8Match = responseData.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/);
        if (m3u8Match) {
            streamUrl = m3u8Match[1];
        } else {
            const iframeMatch = responseData.match(/src=["']?\\?(https?:\/\/[^"'\\]+)["']?/);
            if (iframeMatch) {
                let iframeUrl = iframeMatch[1].replace(/\\\//g, '/');
                console.log(`[4] 發現隱藏的 iframe: ${iframeUrl}`);
                const iframeRes = await fetchViaScraper(iframeUrl, "GET");
                const deepM3u8 = iframeRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8)/);
                if (deepM3u8) streamUrl = deepM3u8[1];
            }
        }

        if (!streamUrl) throw new Error("無法提取最終播放網址");
        console.log(`[5] 成功繞過防護，取得片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `MovieFFM 直連\n(雙重搜尋成功)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        console.error("抓取失敗:", error.message);
        return { streams: [] };
    }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛已啟動於 Port ${port}`);
