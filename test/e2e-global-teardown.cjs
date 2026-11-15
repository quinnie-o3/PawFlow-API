/* P3-BE10 Jest E2E global teardown: drops only the database this run created. */
'use strict';

const qa = require('./qa/qa-env.cjs');

module.exports = async () => {
  const name = process.env.E2E_DB_NAME;
  if (name && process.env.QA_KEEP_DB !== '1') await qa.dropDatabase(name);
};
