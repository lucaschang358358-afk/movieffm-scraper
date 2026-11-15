const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.8",
    name: "MovieFFM 直連外掛 (長效直闖版)",
    description: "延長連線等待時間，給予隱藏瀏覽器足夠時間破解 Cloudflare",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

const baseHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.mvffm.net/"
};

// 核心連線函數，將超時放寬至 30 秒
async function fetchViaScraper(targetUrl, method = "GET", payload = null) {
    const config = {
        method: method,
        timeout: 30000, // 30秒：給足 Cloudflare 驗證與瀏覽器渲染的時間
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
    };

    if (!process.env.SCRAPER_API_KEY) {
        config.url = targetUrl;
        return axios(config);
    }

    config.url = "http://api.scraperapi.com";
    config.params = {
        api_key: process.env.SCRAPER_API_KEY,
        url: targetUrl,
        keep_headers: "true",
        premium: "true",
        render: "true" // 遠端渲染會比較花時間
    };
    return axios(config);
}

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        // 1. 直接從官方庫獲取英文原名
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, { timeout: 3000 });
        const englishTitle = metaRes.data?.meta?.name;

        if (!englishTitle) throw new Error("無法取得英文片名，無法組合網址");

        // 2. 將英文片名轉為網址 Slug
        const slug = englishTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        const directUrl = `https://www.mvffm.net/movies/${slug}/`;
        
        console.log(`[2] 放棄搜尋，直接闖入專屬網址: ${directUrl}`);

        // 3. 進入專屬網頁抓取隱藏的 post_id (這裡最多會等 30 秒)
        const htmlRes = await fetchViaScraper(directUrl, "GET");
        const html = htmlRes.data || "";
        const postIdMatch = html.match(/(?:id="post-|postid-|data-post=")(\d+)/);

        if (!postIdMatch) {
            console.log("[警告] 闖門失敗，該網址不存在此電影，或仍被 Cloudflare 阻擋。");
            return { streams: [] };
        }
        
        const postId = postIdMatch[1];
        console.log(`[3] 闖關成功！挖出內部 post_id: ${postId}`);

        // 4. 打包行李，用 post_id 去後台換取影片
        const ajaxTargetUrl = "https://www.mvffm.net/wp-admin/admin-ajax.php";
        const ajaxPayload = `action=doo_player_ajax&post=${postId}&nume=1&type=movie`;
        console.log(`[4] 發送 API 請求索取影片...`);
        const ajaxRes = await fetchViaScraper(ajaxTargetUrl, "POST", ajaxPayload);

        // 5. 提取 m3u8 網址
        let streamUrl = "";
        const responseData = typeof ajaxRes.data === 'string' ? ajaxRes.data : JSON.stringify(ajaxRes.data);
        
        const m3u8Match = responseData.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/);
        if (m3u8Match) {
            streamUrl = m3u8Match[1];
        } else {
            const iframeMatch = responseData.match(/src=["']?\\?(https?:\/\/[^"'\\]+)["']?/);
            if (iframeMatch) {
                let iframeUrl = iframeMatch[1].replace(/\\\//g, '/');
                console.log(`[5] 發現隱藏 iframe: ${iframeUrl}`);
                const iframeRes = await fetchViaScraper(iframeUrl, "GET");
                const deepM3u8 = iframeRes.data.match(/(https?:\/\/[^"'\s]+\.m3u8)/);
                if (deepM3u8) streamUrl = deepM3u8[1];
            }
        }

        if (!streamUrl) throw new Error("影片解析失敗");
        console.log(`[6] 大功告成！取得片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `MovieFFM 直連\n(長效直闖)`,
                    behaviorHints: { notWebReady: false }
                }
            ]
        };
    } catch (error) {
        console.error("抓取失敗或連線超時:", error.message);
        return { streams: [] };
    }
});

const port = process.env.PORT || 7000;
serveHTTP(builder.getInterface(), { port: port });
console.log(`外掛已啟動於 Port ${port}`);
