// Stitch API helper - uses API Key authentication
const STITCH_API_URL = 'https://stitch.googleapis.com/mcp';
const API_KEY = process.env.STITCH_API_KEY;

let requestId = 0;

async function callTool(name, args) {
  requestId++;
  const body = {
    jsonrpc: '2.0',
    id: requestId,
    method: 'tools/call',
    params: { name, arguments: args }
  };

  const res = await fetch(STITCH_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'X-Goog-Api-Key': API_KEY
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`API error ${res.status}: ${await res.text()}`);
  }

  const json = await res.json();
  if (json.result?.content?.[0]?.text && json.result.isError) {
    throw new Error(`Tool error: ${json.result.content[0].text}`);
  }
  return json.result?.structuredContent || json.result?.content?.[0]?.text;
}

async function main() {
  const action = process.argv[2];

  if (action === 'list') {
    const result = await callTool('list_projects', {});
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'create') {
    const title = process.argv[3] || 'New Project';
    const result = await callTool('create_project', { title });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'generate') {
    const projectId = process.argv[3];
    const prompt = process.argv[4];
    const deviceType = process.argv[5] || 'DESKTOP';
    if (!projectId || !prompt) {
      console.error('Usage: node stitch.js generate <projectId> <prompt> [DESKTOP|MOBILE]');
      process.exit(1);
    }
    console.log('Generating screen... (this may take 1-2 minutes)');
    const result = await callTool('generate_screen_from_text', {
      projectId,
      prompt,
      deviceType
    });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'get') {
    const screenName = process.argv[3]; // e.g. "projects/xxx/screens/yyy"
    if (!screenName) {
      console.error('Usage: node stitch.js get <projects/xxx/screens/yyy>');
      process.exit(1);
    }
    const result = await callTool('get_screen', { name: screenName });
    console.log(JSON.stringify(result, null, 2));
  }
  else if (action === 'screens') {
    const projectId = process.argv[3];
    if (!projectId) {
      console.error('Usage: node stitch.js screens <projectId>');
      process.exit(1);
    }
    const result = await callTool('list_screens', { projectId });
    console.log(JSON.stringify(result, null, 2));
  }
  else {
    console.log('Usage: node stitch.js <list|create|generate|get|screens> [args...]');
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
