// Dados aleatórios. O banco não é limpo entre execuções, então o e-mail precisa ser sempre único.

const random = () => Math.random().toString(36).slice(2, 10);

export function newUser(prefix = 'k6') {
  const id = `${Date.now().toString(36)}${random()}`;
  return {
    name: `K6 ${prefix} ${id}`,
    email: `${prefix}-${id}@k6.test`,
    password: `K6-${random()}-Aa1!`,
  };
}

export function newTodo() {
  return {
    title: `Tarefa ${random()}`,
    description: `Criada pelo k6 em ${new Date().toISOString()}`,
  };
}
