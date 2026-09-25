export default {
  async fetch(request, env) {
    return new Response(
      JSON.stringify({
        status: "ok",
        project: "NSE-BSE-TRACKER-V4",
        database: env.DB ? "connected" : "not connected"
      }),
      {
        headers: {
          "Content-Type": "application/json"
        }
      }
    );
  }
};
