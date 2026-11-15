const { addonBuilder, serveHTTP } = require("stremio-addon-sdk");
const axios = require("axios");

const builder = new addonBuilder({
    id: "org.lucas.ncatscraper",
    version: "1.0.6",
    name: "網飞貓 (全自動搜尋版)",
    description: "支援全站任意電影搜尋與自動解析 m3u8",
    catalogs: [], 
    resources: ["stream"],
    types: ["movie"],
    idPrefixes: ["tt"]
});

// 完整的瀏覽器偽裝 Headers，防止被伺服器拒絕
const browserHeaders = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
    "Referer": "https://www.ncat21.com/"
};

builder.defineStreamHandler(async ({ type, id }) => {
    if (type !== "movie") return { streams: [] };

    try {
        console.log(`\n[1] 收到 Nuvio 請求，IMDB ID: ${id}`);
        
        let tmdbTitle = "";
        let cinemetaTitle = "";

        // 1. 取得中英文片名
        if (process.env.TMDB_API_KEY) {
            const tmdbUrl = `https://api.themoviedb.org/3/find/${id}?api_key=${process.env.TMDB_API_KEY}&external_source=imdb_id&language=zh-TW`;
            const tmdbRes = await axios.get(tmdbUrl, { timeout: 3000 }).catch(() => null);
            tmdbTitle = tmdbRes?.data?.movie_results?.[0]?.title || "";
        }
        
        const metaRes = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${id}.json`, { timeout: 3000 }).catch(() => null);
        cinemetaTitle = metaRes?.data?.meta?.name || "";

        if (!tmdbTitle && !cinemetaTitle) throw new Error("無法解析電影名稱");
        
        const searchKeyword = tmdbTitle || cinemetaTitle;
        console.log(`[2] 準備在網飛貓搜尋: ${searchKeyword}`);

        // 2. 進行站內搜尋
        const searchUrl = `https://www.ncat21.com/search?k=${encodeURIComponent(searchKeyword)}`;
        const searchRes = await axios.get(searchUrl, { headers: browserHeaders, timeout: 8000 });
        
        const html = searchRes.data || "";
        const detailUrlMatch = html.match(/href="(\/detail\/[^"]+\.html)"/i) || html.match(/href="(\/play\/[^"]+\.html)"/i);
        
        if (!detailUrlMatch) {
            console.log(`[警告] 網飛貓搜尋不到此電影: ${searchKeyword}`);
            return { streams: [] };
        }
        
        const detailPath = detailUrlMatch[1];
        const fullDetailUrl = `https://www.ncat21.com${detailPath}`;
        console.log(`[3] 鎖定詳情頁: ${fullDetailUrl}`);

        // 3. 進入詳情頁抓取 m3u8
        const detailRes = await axios.get(fullDetailUrl, { headers: browserHeaders, timeout: 8000 });
        const detailHtml = detailRes.data || "";
        
        const m3u8Match = detailHtml.match(/src:\s*"(https?:\/\/[^"]+\.m3u8)"/i) || detailHtml.match(/(https?:\/\/[^"'\s\\]+\.m3u8)/i);
        
        if (!m3u8Match) {
            throw new Error("頁面中未找到 m3u8 影片源");
        }
        
        const streamUrl = m3u8Match[1].replace(/\\\//g, '/');
        console.log(`[4] 成功抓取片源: ${streamUrl}`);

        return {
            streams: [
                {
                    url: streamUrl,
                    title: `網飛貓 直連\n(全自動秒播)`,
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
console.log(`網飛貓全自動外掛已啟動於 Port ${port}`);
