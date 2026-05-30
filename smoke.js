const URL = 'https://unlmtdwholesale.up.railway.app';
const ADMIN_PASSWORD = 'aintgodgood8587';

async function go(){
  const out = (label, obj)=> console.log('\n== ' + label + ' ==\n', typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  try{
    const catalogRes = await fetch(URL + '/api/catalog');
    const catalog = await catalogRes.text();
    out('GET /api/catalog', catalog);

    const itemsRes = await fetch(URL + '/api/items');
    const items = await itemsRes.text();
    out('GET /api/items', items);

    const loginRes = await fetch(URL + '/api/login', {
      method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({password: ADMIN_PASSWORD})
    });
    const loginJson = await loginRes.json();
    out('POST /api/login', loginJson);
    if(!loginJson.token) throw new Error('Login failed');
    const token = loginJson.token;

    const createRes = await fetch(URL + '/api/items', {
      method: 'POST', headers: {'Content-Type':'application/json','x-admin-token': token},
      body: JSON.stringify({category: 'Smoke', data: { name: 'Smoke Item', price: 1.23 }})
    });
    const createJson = await createRes.json();
    out('POST /api/items (create)', createJson);
    const id = createJson.id;
    if(!id) throw new Error('Create failed');

    const updateRes = await fetch(URL + '/api/items/' + id, {
      method: 'PUT', headers: {'Content-Type':'application/json','x-admin-token': token},
      body: JSON.stringify({category: 'Smoke', data: { name: 'Smoke Item Updated', price: 4.56 }})
    });
    const updateJson = await updateRes.json();
    out('PUT /api/items/:id (update)', updateJson);

    const itemsAfter = await (await fetch(URL + '/api/items')).json();
    out('GET /api/items (after)', itemsAfter);
  }catch(err){
    console.error('ERROR', err);
    process.exitCode = 1;
  }
}

go();
