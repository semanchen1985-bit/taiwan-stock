exports.handler = async function(event, context) {
  // 只允許 POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  // CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
  };

  try {
    const { code } = JSON.parse(event.body);
    if (!code) return { statusCode: 400, body: "Missing code" };

    const prompt = "請搜尋並分析台股代號 " + code + "，輸出完整報告：\n\n=== 行情總覽\n股票名稱、代號、市場、產業別、今日股價、漲跌幅、開高低收、成交量\n\n=== 技術分析\nMA5/MA10/MA20/MA60/MA120 數值與解讀、RSI(14)、KD值（K/D）、MACD（MACD線/Signal/柱狀體）、布林通道（上中下軌）、均線多空排列、量態（爆量/量縮/正常）、是否有黃金或死亡交叉\n\n=== 籌碼分析\n外資近期買賣超張數與趨勢、投信動向、自營商動向、三大法人合計、融資餘額趨勢、融券狀況\n\n=== 基本面\nP/E本益比、P/B淨值比、殖利率、EPS、ROE、毛利率、營收年增率、估值是否合理\n\n=== 產業分析\n產業現況、競爭優勢、成長催化劑\n\n=== 風險分析\n逐項評估：是否過熱、爆量長黑、法人倒貨、融資過高、估值過高、接近壓力、技術轉弱、財報風險\n\n=== 支撐壓力\n第一壓力（數值+原因）\n第二壓力（數值+原因）\n第一支撐（數值+原因）\n第二支撐（數值+原因）\n建議停損（數值）\n\n=== 操作策略\n短線策略（1-5日）\n波段策略（2-4週）\n長線策略（數月以上）\n進場點、停損點、目標價\n\n=== AI綜合分析\n400字以上，用台灣職業交易員口吻深度分析\n\n=== 最終裁定\n整體方向：偏多/偏空/中性震盪\n多空評分：多方X分/空方X分（滿分10分）\n進場建議：\n停損點：\n第一目標：\n第二目標：\n風險等級：高/中/低\n一句話總結：";

    // 呼叫 Claude API（串流）
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 8000,
        stream: true,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.text();
      return {
        statusCode: response.status,
        headers: { "Access-Control-Allow-Origin": "*" },
        body: err
      };
    }

    // 收集所有文字
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";
    let buf = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6).trim();
        if (!raw || raw === "[DONE]") continue;
        try {
          const evt = JSON.parse(raw);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            fullText += evt.delta.text || "";
          }
        } catch {}
      }
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" },
      body: JSON.stringify({ text: fullText })
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: e.message })
    };
  }
};
