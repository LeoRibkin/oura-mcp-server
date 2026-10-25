import { handle } from '../lib/app.js';

export default {
  fetch(request) {
    return handle(request);
  },
};
