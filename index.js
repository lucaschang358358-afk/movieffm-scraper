const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.6",
    name: "MovieFFM 直連外掛 (直闖網址版)",
    description: "新增 URL Slug 直闖模式，破解網站搜尋引擎壞掉的 Bug",
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
            premium: "true",
            render: "true"
        },
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
    });
}

// 輔助函數：執行搜尋或直闖網頁並挖出 post_id
async function getPostIdFromUrl(targetUrl) {
    try {
        const res = await fetchViaScraper(targetUrl, "GET");
        const html = res.data || "";
        const postIdMatch = html.match(/(?:id="post-|postid-|data-post=")(\d+)/);
        if (postIdMatch) return postIdMatch[1];
        return null;
    } catch (e) {
        return null;
    }
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        let tmdbTitle = "";
        let cinemetaTitle = "";

        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl);
            tmdbTitle = tmdbRes.data.movie_results?.[0]?.title || tmdbRes.data.tv_results?.[0]?.name;
        }
        
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`);
        cinemetaTitle = metaRes.data?.meta?.name;

        if (!tmdbTitle && !cinemetaTitle) throw new Error("無法解析電影名稱");

        let postId = null;
        
        // 策略 A: 中文搜尋
        if (tmdbTitle) {
            console.log(`[2A] 嘗試中文搜尋: ${tmdbTitle}`);
            postId = await getPostIdFromUrl(`https://www.mvffm.net/?s=${encodeURIComponent(tmdbTitle)}`);
        }

        // 策略 B: 英文搜尋
        if (!postId && cinemetaTitle && cinemetaTitle !== tmdbTitle) {
            console.log(`[2B] 嘗試英文搜尋: ${cinemetaTitle}`);
            postId = await getPostIdFromUrl(`https://www.mvffm.net/?s=${encodeURIComponent(cinemetaTitle)}`);
        }

        // 策略 C: 直闖專屬網址 (根據截圖發現的網址規律)
        if (!postId && cinemetaTitle) {
            // 將英文片名轉為網址格式 (Lovesick -> lovesick, Just For Meeting You -> just-for-meeting-you)
            const slug = cinemetaTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            const directUrl = `https://www.mvffm.net/movies/${slug}/`;
            console.log(`[2C] 網站搜尋引擎疑似壞掉，嘗試直接闖入網址: ${directUrl}`);
            postId = await getPostIdFromUrl(directUrl);
        }

        if (!postId) throw new Error("所有抓取策略皆失敗，可能是網站沒有此片，或網址格式不符");
        console.log(`[3] 成功挖出內部 post_id: ${postId}`);

        const ajaxTargetUrl = "https://www.mvffm.net/wp-admin/admin-ajax.php";
        const ajaxPayload = `action=doo_player_ajax&post=${postId}&nume=1&type=movie`;
        console.log(`[4] 發送 API 請求索取影片...`);
        const ajaxRes = await fetchViaScraper(ajaxTargetUrl, "POST", ajaxPayload);

        let streamUrl = "";
        const responseData = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        
        const m3u8Match = responseData.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/);
        if (m3u8Match) {
            streamUrl = m3u8Match[1];
        } else {
            const iframeMatch = responseData.match(/src=["']?\\?(https?:\/\/[^"'\\]+)["']?/);
            if (iframeMatch) {
                let iframeUrl = iframeMatch[1].replace(/\\\//g, '/');
                console.log(`[5] 發現隱藏的 iframe: ${iframeUrl}`);
                const iframeRes = await fetchViaScraper(iframeUrl, "GET");
                const deepM3u8 = iframeRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8)/);
                if (deepM3u8) streamUrl = deepM3u8[1];
            }
        }

        if (!streamUrl) throw new Error("無法提取最終播放網址");
        console.log(`[6] 成功取得片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `MovieFFM 直連\n(直闖網址版)`,
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
