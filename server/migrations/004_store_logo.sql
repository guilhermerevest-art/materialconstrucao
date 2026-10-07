-- A logo da loja identifica o papel impresso do orçamento: o cliente precisa ver
-- de quem é a proposta. Ela fica no banco, em base64, e não em disco nem dentro do
-- app, porque o mesmo código roda na Vercel e na VPS ao mesmo tempo: o que existe
-- num servidor local não acompanha o outro deploy, e o PDF sairia sem logo
-- dependendo de onde foi gerado.

alter table stores add column logo_data text;
alter table stores add column logo_mime text;

-- As duas colunas andam juntas: logo sem mime não sabe como ser desenhada, e mime
-- sem logo é sobeira. A lista fechada evita que a tela tente exibir como imagem um
-- tipo que o navegador e o PDF não reconhecem. A API ainda mede o tamanho da
-- imagem, mas o limite do corpo da requisição (1 MB em express.json) muda sem
-- ninguém lembrar daqui.
alter table stores add constraint stores_logo_pair check (
  (logo_data is null) = (logo_mime is null)
  and (logo_mime is null or logo_mime in ('image/png', 'image/jpeg', 'image/webp'))
);