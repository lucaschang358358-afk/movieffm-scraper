const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.1",
    name: "MovieFFM 直連外掛 (突破防護)",
    description: "自動轉換中文片名並透過 Scraper API 繞過 Cloudflare 抓取片源",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

// 模擬瀏覽器的基本標頭
const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.mvffm.net/"
};

// 核心函數：負責將請求轉發給 Scraper API 繞過防護
async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    if (!process.env.SCRAPER_API_KEY) {
        // 若未設定 API Key，則直接連線 (適合在本地端測試時使用)
        return axios({ 
            method: method, 
            url: targetUrl, 
            data: payload, 
            headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders 
        });
    }

    // 透過 Scraper API 代理發送請求 (以標準 ScraperAPI 格式為例)
    return axios({
        method: method,
        url: "http://api.scraperapi.com",
        params: {
            api_key: process.env.SCRAPER_API_KEY,
            url: targetUrl
        },
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
    });
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        // --- 階段 A: 解決片名語言問題 (英文轉中文) ---
        let movieTitle = "";
        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl);
            movieTitle = tmdbRes.data.movie_results?.[0]?.title || tmdbRes.data.tv_results?.[0]?.name;
        }
        
        if (!movieTitle) {
            const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
            movieTitle = metaRes.data?.meta?.name;
        }
        if (!movieTitle) throw new Error("無法解析電影名稱");
        console.log(`[2] 準備搜尋中文片名: ${movieTitle}`);

        // --- 階段 B: 解決 Cloudflare 403 封鎖 (透過代理搜尋) ---
        const searchTargetUrl = `https://www.mvffm.net/?s=${encodeURIComponent(movieTitle)}`;
        const searchRes = await fetchViaScraper(searchTargetUrl, "GET");
        
        const postIdMatch = searchRes.data.match(/id="post-(\d+)"/);
        if (!postIdMatch) throw new Error("網站上找不到這部電影");
        const postId = postIdMatch[1];
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
                    title: `MovieFFM 直連\n(繞過防護成功)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        // 印出詳細的錯誤資訊方便 Debug，例如是否還是回傳 403
        console.error("抓取失敗:", error.response ? `Status: ${error.response.status}` : error.message);
        return { streams: [] };
    }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛已啟動於 Port ${port}`);
