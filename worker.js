export default {
async fetch(request, env) {
try {
await env.DB.prepare(
"DROP TABLE IF EXISTS test"
).run();

return new Response(  
    JSON.stringify({  
      status: "ok",  
      project: "NSE-BSE-TRACKER-V4",  
      message: "Test table removed successfully"  
    }),  
    {  
      headers: {  
        "Content-Type": "application/json"  
      }  
    }  
  );  
} catch (error) {  
  return new Response(  
    JSON.stringify({  
      status: "error",  
      message: error.message  
    }),  
    {  
      status: 500,  
      headers: {  
        "Content-Type": "application/json"  
      }  
    }  
  );  
}

}
};
