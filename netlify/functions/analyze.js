exports.handler = async function(event, context) {
  context.callbackWaitsForEmptyEventLoop = false;

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      },
      body: ""
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  try {
    const { code } = JSON.parse(event.body);
    if (!code) return { statusCode: 400, body: "Missing code" };

    const prompt = "分析台股代號 " + code + "，輸出以下格式報告：\n\n=== 行情總覽\n股票名稱、代號、市場、產業、今日股價漲跌開高低量\n\n=== 技術分析\nMA5/MA10/MA20/MA60數值、RSI、KD、MACD、布林通道、均線排列、量態\n\n=== 籌碼分析\n外資投信自營商近期買賣超、融資融券狀況\n\n=== 基本面\nPE、PB、殖利率、EPS、ROE、毛利率、營收年增率\n\n=== 風險分析\n主要風險逐項評估\n\n=== 支撐壓力\n第一壓力、第二壓力、第一支撐、第二支撐、建議停損（附數值）\n\n=== 操作策略\n短線/波段/長線策略，進場點停損目標\n\n=== AI綜合分析\n300字，職業交易員口吻\n\n=== 最終裁定\n整體方向（偏多/偏空/中性）、進場建議、停損、目標、風險等級、一句話總結";

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 4000,
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

    const data = await response.json();
    
    // 收集所有文字 block
    const fullText = (data.content || [])
      .filter(b => b.type === "text")
      .map(b => b.text)
      .join("");

    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Content-Type": "application/json"
      },
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
