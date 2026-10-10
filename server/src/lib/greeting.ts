/**
 * Como chamar o cliente no "Olá, ...!" das mensagens: o primeiro nome do contato, se tiver;
 * empresa (CNPJ) pelo nome inteiro, porque "Olá, Construtora!" soa estranho; pessoa pelo
 * primeiro nome.
 */
export function greetingName(client: { name: string; contact_name?: string | null; person_type?: string | null }) {
  const first = (value: string) => value.trim().split(/\s+/)[0] ?? '';
  if (client.contact_name?.trim()) return first(client.contact_name);
  if (client.person_type === 'J') return client.name.trim();
  return first(client.name);
}
