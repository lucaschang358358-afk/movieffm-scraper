const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.4",
    name: "MovieFFM 直連外掛 (渲染突破版)",
    description: "加入 render 參數，強制 Scraper API 執行 JS 來破解 Cloudflare 驗證盾",
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
            render: "true" // 關鍵武器：強制開啟隱藏瀏覽器，等待 JS 跑完、通過 Cloudflare 盾
        },
        data: payload,
        headers: payload ? { "Content-Type": "application/x-www-form-urlencoded", ...baseHeaders } : baseHeaders
    });
}

// 輔助函數：執行搜尋並挖出 post_id，加入超強 Debug 功能
async function searchMovieAndGetPostId(title) {
    console.log(`[搜尋] 準備發送搜尋請求: ${title}`);
    const searchTargetUrl = `https://www.mvffm.net/?s=${encodeURIComponent(title)}`;
    const searchRes = await fetchViaScraper(searchTargetUrl, "GET");
    
    const html = searchRes.data || "";
    const postIdMatch = html.match(/id="post-(\d+)"/);
    
    if (postIdMatch) {
        return postIdMatch[1];
    } else {
        // 如果找不到，就把 ScraperAPI 實際抓到的網頁開頭印出來，讓我們看是不是被驗證碼卡住
        const snippet = typeof html === 'string' ? html.substring(0, 200).replace(/\n/g, '') : "非文字格式";
        console.log(`[警告] 找不到 post_id！網站實際回傳的內容開頭是: ${snippet}...`);
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
        
        // 優先用中文搜
        if (tmdbTitle) {
            console.log(`[2A] 優先使用中文搜尋: ${tmdbTitle}`);
            postId = await searchMovieAndGetPostId(tmdbTitle);
        }

        // 如果中文搜不到，退回用英文搜
        if (!postId && cinemetaTitle && cinemetaTitle !== tmdbTitle) {
            console.log(`[2B] 中文搜不到，退回使用英文搜尋: ${cinemetaTitle}`);
            postId = await searchMovieAndGetPostId(cinemetaTitle);
        }

        // 最後備案：直接拿 IMDB ID 去搜 (有些 WordPress 主題支援這種搜法)
        if (!postId) {
            console.log(`[2C] 雙語皆失敗，嘗試直接搜尋 IMDB ID: ${id}`);
            postId = await searchMovieAndGetPostId(id);
        }

        if (!postId) throw new Error("完全找不到該電影，請查看上方日誌回傳的網頁內容");
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
                    title: `MovieFFM 直連\n(完美渲染版)`,
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
