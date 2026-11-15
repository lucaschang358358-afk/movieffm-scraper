const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.movieffmscraper",
    version: "1.0.5",
    name: "MovieFFM 直連外掛 (無死角雷達版)",
    description: "升級正則表達式，解決 WordPress 精準命中跳轉導致抓不到 ID 的問題",
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

// 輔助函數：執行搜尋並挖出 post_id (升級雷達版)
async function searchMovieAndGetPostId(title) {
    console.log(`[搜尋] 準備發送搜尋請求: ${title}`);
    const searchTargetUrl = `https://www.mvffm.net/?s=${encodeURIComponent(title)}`;
    const searchRes = await fetchViaScraper(searchTargetUrl, "GET");
    
    const html = searchRes.data || "";
    
    // 終極正則表達式：同時涵蓋「搜尋列表 (id="post-xxx")」、「單頁跳轉 (postid-xxx)」、「播放按鈕 (data-post="xxx")」
    const postIdMatch = html.match(/(?:id="post-|postid-|data-post=")(\d+)/);
    
    if (postIdMatch) {
        return postIdMatch[1];
    } else {
        const snippet = typeof html === 'string' ? html.substring(0, 300).replace(/\n/g, '') : "非文字格式";
        console.log(`[警告] 雷達掃描不到 post_id！回傳網頁開頭: ${snippet}...`);
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

        // 退回英文搜
        if (!postId && cinemetaTitle && cinemetaTitle !== tmdbTitle) {
            console.log(`[2B] 中文搜不到，退回使用英文搜尋: ${cinemetaTitle}`);
            postId = await searchMovieAndGetPostId(cinemetaTitle);
        }

        // 終極備案：直接用 IMDB ID 搜
        if (!postId) {
            console.log(`[2C] 雙語失敗，嘗試搜尋 IMDB ID: ${id}`);
            postId = await searchMovieAndGetPostId(id);
        }

        if (!postId) throw new Error("雷達掃描失敗，可能網站真的沒有這部片，或是片名翻譯落差太大");
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
                    title: `MovieFFM 直連\n(無死角雷達版)`,
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
