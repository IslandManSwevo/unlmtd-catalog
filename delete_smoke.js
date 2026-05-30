const URL = 'https://unlmtdwholesale.up.railway.app';
const ADMIN_PASSWORD = 'aintgodgood8587';

async function run(){
  try{
    const login = await (await fetch(URL + '/api/login', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({password: ADMIN_PASSWORD})})).json();
    if(!login.token) return console.error('Login failed', login);
    const token = login.token;
    console.log('Got token, deleting item id=1');
    const del = await (await fetch(URL + '/api/items/1', {method:'DELETE', headers: {'x-admin-token': token}})).json();
    console.log('DELETE response:', del);
    const items = await (await fetch(URL + '/api/items')).json();
    console.log('Items now:', items);
  }catch(err){
    console.error('Error', err);
    process.exitCode = 1;
  }
}
run();
