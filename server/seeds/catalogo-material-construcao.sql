-- Catálogo inicial de material de construção (100 produtos, códigos 1 a 100)
-- para uma lojamestre.
--
-- Para outra lojamestre, troque 'confere' no passo 2.
--
-- psql:    psql "$DATABASE_URL" -f server/seeds/catalogo-material-construcao.sql
-- DBeaver: abra o arquivo no editor SQL e execute como script (Alt+X).
--
-- Comandos SQL simples, sem bloco DO e sem comentário ou linha em branco
-- dentro de um comando: o DBeaver trata linha de comentário como linha em
-- branco e corta o comando ali.
--
-- Pode rodar mais de uma vez: produto com código que a lojamestre já tem é
-- pulado, nada é alterado nem duplicado. Os preços são de referência; revise
-- em Administração → Produtos antes de usar nos pedidos.
--
-- products tem RLS forçado por lojamestre: o passo 2 define app.tenant_id
-- nesta conexão e o passo 5 limpa. Se a lojamestre não existir, o passo 2 não
-- devolve linha e o passo 3 falha sem gravar nada.

-- 1. Limpa um contexto que tenha sobrado nesta conexão.
select set_config('app.tenant_id', '', false);

-- 2. Lojamestre que recebe os produtos (deve aparecer 1 linha).
select id, slug, name, set_config('app.tenant_id', id::text, false) as contexto
  from tenants
 where lower(slug) = 'confere';

-- 3. Produtos.
insert into products (tenant_id, code, name, unit, price)
select app_tenant_id(), v.code, v.name, v.unit, v.price
  from (values
      ('1',   'Cimento CP II-E-32 50 kg',                        'SC',  38.90),
      ('2',   'Cimento CP III-40 RS 50 kg',                      'SC',  39.90),
      ('3',   'Cimento CP V-ARI 40 kg',                          'SC',  41.50),
      ('4',   'Cimento branco 5 kg',                             'UN',  22.90),
      ('5',   'Argamassa AC-I interna 20 kg',                    'SC',  18.50),
      ('6',   'Argamassa AC-II interna e externa 20 kg',         'SC',  27.90),
      ('7',   'Argamassa AC-III 20 kg',                          'SC',  42.90),
      ('8',   'Argamassa para assentamento de alvenaria 20 kg',  'SC',  16.90),
      ('9',   'Argamassa para reboco 20 kg',                     'SC',  17.90),
      ('10',  'Cal hidratada CH-III 20 kg',                      'SC',  16.90),
      ('11',  'Gesso em pó 40 kg',                               'SC',  44.90),
      ('12',  'Areia fina lavada',                               'M³', 150.00),
      ('13',  'Areia média lavada',                              'M³', 145.00),
      ('14',  'Areia grossa lavada',                             'M³', 140.00),
      ('15',  'Areia média ensacada 20 kg',                      'SC',   7.90),
      ('16',  'Pedrisco (brita 0)',                              'M³', 165.00),
      ('17',  'Brita 1',                                         'M³', 160.00),
      ('18',  'Tijolo cerâmico 6 furos 9x14x19',                 'UN',   0.95),
      ('19',  'Tijolo cerâmico 8 furos 9x19x19',                 'UN',   1.35),
      ('20',  'Tijolo maciço comum',                             'UN',   0.85),
      ('21',  'Bloco de concreto 9x19x39',                       'UN',   3.20),
      ('22',  'Bloco de concreto 14x19x39',                      'UN',   4.20),
      ('23',  'Bloco de concreto 19x19x39',                      'UN',   5.40),
      ('24',  'Canaleta de concreto 14x19x39',                   'UN',   4.90),
      ('25',  'Vergalhão CA-50 6,3 mm barra 12 m',               'BR',  24.90),
      ('26',  'Vergalhão CA-50 8 mm barra 12 m',                 'BR',  36.50),
      ('27',  'Vergalhão CA-50 10 mm barra 12 m',                'BR',  54.90),
      ('28',  'Vergalhão CA-50 12,5 mm barra 12 m',              'BR',  84.90),
      ('29',  'Vergalhão CA-60 4,2 mm barra 12 m',               'BR',  12.90),
      ('30',  'Arame recozido nº 18',                            'KG',  19.90),
      ('31',  'Tela soldada Q-92 2 x 3 m',                       'PC',  89.00),
      ('32',  'Coluna armada 9x9 cm barra 6 m',                  'PC',  59.90),
      ('33',  'Treliça H8 barra 6 m',                            'PC',  39.90),
      ('34',  'Prego com cabeça 15x15',                          'KG',  21.90),
      ('35',  'Prego com cabeça 17x27',                          'KG',  18.90),
      ('36',  'Prego com cabeça 18x30',                          'KG',  18.90),
      ('37',  'Bucha de nylon nº 6 caixa com 100',               'CX',  14.90),
      ('38',  'Parafuso chipboard 4,5 x 40 mm caixa com 100',    'CX',  24.90),
      ('39',  'Espuma expansiva de poliuretano 500 ml',          'UN',  32.90),
      ('40',  'Tábua de pinus 30 cm x 3 m',                      'PC',  34.90),
      ('41',  'Sarrafo de pinus 5 cm x 3 m',                     'PC',   7.90),
      ('42',  'Pontalete de eucalipto 7 x 7 cm x 3 m',           'PC',  18.90),
      ('43',  'Compensado resinado 10 mm 1,10 x 2,20 m',         'PC',  79.90),
      ('44',  'Tubo PVC soldável 20 mm barra 6 m',               'BR',  18.90),
      ('45',  'Tubo PVC soldável 25 mm barra 6 m',               'BR',  24.90),
      ('46',  'Tubo PVC soldável 32 mm barra 6 m',               'BR',  44.90),
      ('47',  'Tubo PVC esgoto 40 mm barra 6 m',                 'BR',  32.90),
      ('48',  'Tubo PVC esgoto 50 mm barra 6 m',                 'BR',  44.90),
      ('49',  'Tubo PVC esgoto 100 mm barra 6 m',                'BR',  69.90),
      ('50',  'Joelho PVC soldável 90° 25 mm',                   'UN',   1.80),
      ('51',  'Joelho PVC esgoto 90° 100 mm',                    'UN',   9.90),
      ('52',  'Tê PVC soldável 25 mm',                           'UN',   2.40),
      ('53',  'Luva PVC soldável 25 mm',                         'UN',   1.20),
      ('54',  'Registro de esfera PVC soldável 25 mm',           'UN',  14.90),
      ('55',  'Registro de gaveta bruto 3/4"',                   'UN',  54.90),
      ('56',  'Caixa d''água polietileno 500 L',                 'UN', 329.00),
      ('57',  'Caixa d''água polietileno 1.000 L',               'UN', 499.00),
      ('58',  'Caixa sifonada 100x100x50 mm com grelha',         'UN',  19.90),
      ('59',  'Adesivo para PVC 175 g',                          'UN',  18.90),
      ('60',  'Fita veda-rosca 18 mm x 25 m',                    'UN',   6.90),
      ('61',  'Cabo flexível 1,5 mm² rolo 100 m',                'RL', 159.00),
      ('62',  'Cabo flexível 2,5 mm² rolo 100 m',                'RL', 239.00),
      ('63',  'Cabo flexível 4 mm² rolo 100 m',                  'RL', 379.00),
      ('64',  'Eletroduto corrugado 20 mm rolo 50 m',            'RL',  49.90),
      ('65',  'Caixa de luz 4x2 de embutir',                     'UN',   1.90),
      ('66',  'Tomada 2P+T 10 A com placa',                      'UN',  12.90),
      ('67',  'Interruptor simples 10 A com placa',              'UN',  11.90),
      ('68',  'Disjuntor monopolar DIN 20 A',                    'UN',  14.90),
      ('69',  'Quadro de distribuição de embutir 12 disjuntores','UN',  79.90),
      ('70',  'Fita isolante 19 mm x 20 m',                      'UN',   8.90),
      ('71',  'Lâmpada LED bulbo 9 W luz branca',                'UN',   9.90),
      ('72',  'Tinta acrílica fosca branco neve 18 L',           'LT', 389.00),
      ('73',  'Tinta látex PVA branca 18 L',                     'LT', 219.00),
      ('74',  'Esmalte sintético branco brilhante 3,6 L',        'LT', 119.00),
      ('75',  'Selador acrílico 18 L',                           'LT', 179.00),
      ('76',  'Massa corrida PVA 25 kg',                         'UN',  79.90),
      ('77',  'Massa acrílica 25 kg',                            'UN', 119.00),
      ('78',  'Textura acrílica 25 kg',                          'UN',  99.90),
      ('79',  'Rolo de lã 23 cm com cabo',                       'UN',  24.90),
      ('80',  'Trincha 2"',                                      'UN',   9.90),
      ('81',  'Fita crepe 48 mm x 50 m',                         'UN',  12.90),
      ('82',  'Impermeabilizante acrílico 18 L',                 'UN', 259.00),
      ('83',  'Manta asfáltica 3 mm rolo 10 m',                  'RL', 219.00),
      ('84',  'Argamassa polimérica impermeabilizante 18 kg',    'CX',  89.90),
      ('85',  'Porcelanato acetinado 60x60 cm',                  'M²',  79.90),
      ('86',  'Piso cerâmico 45x45 cm PEI 4',                    'M²',  34.90),
      ('87',  'Revestimento cerâmico de parede 30x60 cm',        'M²',  39.90),
      ('88',  'Rejunte flexível cinza 1 kg',                     'KG',   9.90),
      ('89',  'Rejunte flexível branco 1 kg',                    'KG',   9.90),
      ('90',  'Telha de fibrocimento 2,44 x 1,10 m 6 mm',        'UN',  69.90),
      ('91',  'Telha cerâmica portuguesa',                       'UN',   2.90),
      ('92',  'Cumeeira de fibrocimento 6 mm',                   'UN',  34.90),
      ('93',  'Carrinho de mão 60 L pneu com câmara',            'UN', 249.00),
      ('94',  'Pá de bico com cabo',                             'UN',  59.90),
      ('95',  'Colher de pedreiro 8"',                           'UN',  24.90),
      ('96',  'Desempenadeira de aço dentada 12 x 25 cm',        'UN',  29.90),
      ('97',  'Nível de alumínio 40 cm',                         'UN',  34.90),
      ('98',  'Trena 5 m',                                       'UN',  19.90),
      ('99',  'Luva de raspa',                                   'PAR', 12.90),
      ('100', 'Lona plástica preta 4 x 6 m',                     'PC',  39.90)
    ) as v (code, name, unit, price)
  on conflict (tenant_id, lower(code)) where code is not null do nothing;

-- 4. Conferência: deve mostrar 100.
select count(*) as produtos_no_catalogo from products where tenant_id = app_tenant_id();

-- 5. Limpa o contexto.
select set_config('app.tenant_id', '', false);
