import http from 'k6/http';
import { sleep } from 'k6';

export const options = {
  vus: 1,
  duration: '30s',
}

export default function() {
  http.get('http://localhost:5665');
  sleep(1);
}