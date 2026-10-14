export class PayloadTooLargeError extends Error {
  constructor() {
    super('Corpo da requisicao muito grande.');
    this.name = 'PayloadTooLargeError';
    this.statusCode = 413;
  }
}

export function requestBodyError(error) {
  if (error?.statusCode === 413) {
    return { statusCode: 413, message: error.message };
  }
  return { statusCode: 400, message: error?.message || 'Requisicao invalida.' };
}

export function readBody(request, maximumSize = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    request.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maximumSize) {
        request.pause();
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });

    request.on('error', (error) => fail(error));
  });
}
