const express = require('express');
const path = require('path');
const { db, initDatabase, generateOrderNumber } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

initDatabase();

app.use(express.json({ limit: '2mb' }));
app.use(express.static(ROOT));
app.use('/assets', express.static(path.join(ROOT, 'assets')));

const STATUS_LABELS = {
  created: 'Заявка создана',
  accepted: 'Принят',
  diagnosed: 'Диагностика',
  in_progress: 'В работе',
  ready: 'Готов',
  completed: 'Выдан'
};

const STATUS_PROGRESS = {
  created: 20,
  accepted: 40,
  diagnosed: 60,
  in_progress: 80,
  ready: 95,
  completed: 100
};

function jsonOk(res, data) {
  res.json({ ok: true, ...data });
}

function jsonErr(res, status, message) {
  res.status(status).json({ ok: false, error: message });
}

app.get('/api/health', (_req, res) => {
  jsonOk(res, { message: 'Точка Пая API работает' });
});

app.get('/api/services', (req, res) => {
  const { category, brand } = req.query;
  let sql = 'SELECT * FROM services WHERE 1=1';
  const params = {};
  if (category && category !== 'all') {
    sql += ' AND category = @category';
    params.category = category;
  }
  if (brand && brand !== 'all') {
    sql += ' AND (brand = @brand OR brand = \'all\')';
    params.brand = brand;
  }
  sql += ' ORDER BY is_popular DESC, name ASC';
  const rows = db.prepare(sql).all(params);
  jsonOk(res, { services: rows });
});

app.get('/api/products', (req, res) => {
  const { category, brand, search, sort } = req.query;
  let sql = 'SELECT * FROM products WHERE 1=1';
  const params = {};

  if (category && category !== 'Все категории') {
    sql += ' AND category = @category';
    params.category = category;
  }
  if (brand && brand !== 'Все бренды') {
    sql += ' AND brand = @brand';
    params.brand = brand;
  }
  if (search) {
    sql += ' AND (name LIKE @q OR compatibility LIKE @q OR category LIKE @q)';
    params.q = `%${search}%`;
  }

  if (sort === 'price_asc') sql += ' ORDER BY price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY price DESC';
  else sql += ' ORDER BY name ASC';

  jsonOk(res, { products: db.prepare(sql).all(params) });
});

app.get('/api/orders/:orderNumber', (req, res) => {
  const orderNumber = decodeURIComponent(req.params.orderNumber).trim();
  const order = db.prepare('SELECT * FROM repair_orders WHERE order_number = ?').get(orderNumber);
  if (!order) return jsonErr(res, 404, 'Заказ не найден. Проверьте номер на квитанции.');

  const history = db
    .prepare('SELECT * FROM order_history WHERE order_id = ? ORDER BY created_at DESC, id DESC')
    .all(order.id);

  jsonOk(res, {
    order: {
      ...order,
      symptoms: order.symptoms ? order.symptoms.split(',') : [],
      status_label: STATUS_LABELS[order.status] || order.status,
      progress: STATUS_PROGRESS[order.status] || 0
    },
    history
  });
});

app.post('/api/orders', (req, res) => {
  const body = req.body || {};
  const clientName = (body.client_name || '').trim();
  const clientPhone = (body.client_phone || '').trim();

  if (!clientName || !clientPhone) {
    return jsonErr(res, 400, 'Укажите имя и телефон');
  }
  if (!body.device_type) {
    return jsonErr(res, 400, 'Выберите тип устройства');
  }

  const orderNumber = generateOrderNumber();
  const symptoms = Array.isArray(body.symptoms) ? body.symptoms.join(',') : body.symptoms || '';

  const result = db.prepare(`
    INSERT INTO repair_orders (
      order_number, client_name, client_phone, client_email, contact_method,
      device_type, device_brand, device_model, symptoms, description,
      estimated_min, estimated_max, status
    ) VALUES (
      @order_number, @client_name, @client_phone, @client_email, @contact_method,
      @device_type, @device_brand, @device_model, @symptoms, @description,
      @estimated_min, @estimated_max, 'created'
    )
  `).run({
    order_number: orderNumber,
    client_name: clientName,
    client_phone: clientPhone,
    client_email: body.client_email || null,
    contact_method: body.contact_method || 'phone',
    device_type: body.device_type,
    device_brand: body.device_brand || null,
    device_model: body.device_model || null,
    symptoms,
    description: body.description || null,
    estimated_min: body.estimated_min || null,
    estimated_max: body.estimated_max || null
  });

  db.prepare('INSERT INTO order_history (order_id, status, note) VALUES (?, ?, ?)').run(
    result.lastInsertRowid,
    'created',
    'Заявка создана через сайт'
  );

  jsonOk(res, {
    order_number: orderNumber,
    message: `Заявка ${orderNumber} принята. Перезвоним в течение 5 минут.`
  });
});

app.post('/api/courier', (req, res) => {
  const body = req.body || {};
  const clientName = (body.client_name || '').trim();
  const clientPhone = (body.client_phone || '').trim();
  const address = (body.address || '').trim();

  if (!clientName || !clientPhone || !address) {
    return jsonErr(res, 400, 'Заполните имя, телефон и адрес');
  }

  db.prepare(`
    INSERT INTO courier_requests (client_name, client_phone, address, pickup_date, pickup_time, device_type, problem_description)
    VALUES (@client_name, @client_phone, @address, @pickup_date, @pickup_time, @device_type, @problem_description)
  `).run({
    client_name: clientName,
    client_phone: clientPhone,
    address,
    pickup_date: body.pickup_date || null,
    pickup_time: body.pickup_time || null,
    device_type: body.device_type || null,
    problem_description: body.problem_description || null
  });

  jsonOk(res, { message: 'Курьер вызван! Мы перезвоним для подтверждения времени.' });
});

app.post('/api/shop-orders', (req, res) => {
  const body = req.body || {};
  const items = body.items;

  if (!Array.isArray(items) || items.length === 0) {
    return jsonErr(res, 400, 'Корзина пуста');
  }

  const total = items.reduce((sum, item) => sum + (item.price || 0), 0);

  db.prepare(`
    INSERT INTO shop_orders (client_name, client_phone, items_json, total)
    VALUES (@client_name, @client_phone, @items_json, @total)
  `).run({
    client_name: body.client_name || null,
    client_phone: body.client_phone || null,
    items_json: JSON.stringify(items),
    total
  });

  jsonOk(res, {
    message: `Заказ на ${total.toLocaleString('ru-RU')} ₽ оформлен. Менеджер свяжется с вами.`,
    total
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT, 'tochka_paya_index.html'));
});

app.listen(PORT, () => {
  console.log(`Точка Пая: http://localhost:${PORT}`);
});
