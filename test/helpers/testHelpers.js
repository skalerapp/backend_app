const request = require('supertest');
const app = require('../../src/server');
const { closeDatabase } = require('../../src/config/database');

const login = async ({ email, password }) => {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email, password });

  expect(res.statusCode).toBe(200);
  expect(res.body.token).toBeDefined();

  return res.body;
};

const createUser = async ({ authToken, name, email, password, role }) => {
  const res = await request(app)
    .post('/api/users')
    .set('Authorization', `Bearer ${authToken}`)
    .send({ name, email, password, role });

  expect(res.statusCode).toBe(201);
  expect(res.body?.data?.id).toBeDefined();

  return res.body.data;
};

const loginAs = async ({ authToken, name, email, password, role }) => {
  if (!authToken) {
    throw new Error('loginAs requires authToken');
  }

  const user = await createUser({ authToken, name, email, password, role });
  const auth = await login({ email, password });
  return { token: auth.token, user };
};

module.exports = {
  request,
  app,
  closeDatabase,
  login,
  createUser,
  loginAs,
};
