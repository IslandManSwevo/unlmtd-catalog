const URL = process.argv[2] || 'https://unlmtdwholesale.up.railway.app';
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD || process.argv[3];

async function go(){
  const out = (label, obj)=> console.log('\n== ' + label + ' ==\n', typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  try{
    if(!ADMIN_PASSWORD){
      console.error('ERROR: missing admin password. Set SMOKE_ADMIN_PASSWORD or pass it as the second CLI arg.');
      process.exit(1);
    }
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

    const checkoutRes = await fetch(URL + '/api/checkout', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        customer: { name: 'Smoke Test', phone: '12425550100', email: 'smoke@example.com', city: 'Nassau', address: '123 Test Rd', notes: 'smoke test order' },
        items: [{ id, qty: 2, size: 'M' }],
      })
    });
    const checkoutJson = await checkoutRes.json();
    out('POST /api/checkout', checkoutJson);
    if(!/^UNL-\d{4}-\d{4}$/.test(checkoutJson.code || '')) throw new Error('Unexpected order code format: ' + checkoutJson.code);
    if(!checkoutJson.orderId) throw new Error('Checkout did not return an orderId');

    const trackJson = await (await fetch(URL + '/api/track/' + checkoutJson.code)).json();
    out('GET /api/track/:code', trackJson);
    if(trackJson.stage !== 0) throw new Error('Expected new checkout order at stage 0, got ' + trackJson.stage);

    const deleteOrderRes = await fetch(URL + '/api/orders/' + checkoutJson.orderId, {
      method: 'DELETE', headers: {'x-admin-token': token}
    });
    out('DELETE /api/orders/:id (checkout cleanup)', await deleteOrderRes.json());
  }catch(err){
    console.error('ERROR', err);
    process.exitCode = 1;
  }
}

go();
