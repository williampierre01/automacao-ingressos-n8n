export function rodarRotinas(rotinas, registrar = () => {}) {
  const resultados = [];
  for (const rotina of rotinas) {
    try {
      rotina();
      resultados.push(true);
    } catch (error) {
      registrar(error);
      resultados.push(false);
    }
  }
  return resultados;
}
