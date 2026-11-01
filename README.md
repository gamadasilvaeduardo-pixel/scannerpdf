# ScanPDF

Scanner de documentos em **PWA**, gratuito, sem dependências JavaScript externas e com geração de PDF **100% no dispositivo**.

## Recursos

- Fotografar documentos no celular ou importar várias imagens.
- Detecção inicial das bordas por contraste (com ajuste manual dos quatro cantos).
- Correção de perspectiva, rotação de 90°, filtros melhorado, original, tons de cinza e P&B adaptativo.
- Reordenar, adicionar e remover páginas.
- Exportar PDFs A4 com resolução configurável, sem upload.
- Preservar rascunhos no **IndexedDB** (enquanto o navegador não limpar os dados locais).
- Instalar como PWA e trabalhar offline depois do primeiro carregamento/cache.
- Funciona sem cadastro, sem backend e sem serviços de terceiros.

**Limitações:** a detecção automática funciona melhor com papel contrastando com o fundo; ajuste os cantos quando necessário. Não oferece OCR pesquisável. O sistema pode remover dados armazenados no navegador por falta de espaço ou limpeza de dados; exporte seus PDFs importantes. Arquivos HEIC/HEIF só funcionam quando suportados pelo navegador. O PDF contém imagens de páginas (sem texto selecionável).

## Publicar no GitHub Pages

1. Crie um repositório público chamado `scanner-pdf`.
2. Envie todos os arquivos e a pasta `icons/` para a raiz do repositório (`index.html`, `app.js`, `styles.css`, `sw.js`, `manifest.webmanifest`, `.nojekyll`).
3. Em **Settings → Pages → Build and deployment**, selecione **Deploy from a branch**, branch **main**, diretório **/(root)** e clique em **Save**.
4. Abra `https://SEU_USUARIO.github.io/scanner-pdf/`.
5. No celular, use o menu do navegador **Adicionar à tela inicial**; abra o app ao menos uma vez conectado à internet antes de utilizá-lo offline.

> O GitHub Pages para repositórios públicos é adequado a esta publicação gratuita, não a infraestrutura de SaaS comercial.

## Testar localmente

Para testes locais no computador, na pasta do projeto:

```bash
python -m http.server 8000
```

Abra http://localhost:8000. Para testar a câmera no celular, utilize HTTPS (GitHub Pages já fornece HTTPS).

## Privacidade e arquitetura

O projeto não contém recursos de upload nem chamadas a APIs externas. O navegador carrega o próprio aplicativo pelo GitHub Pages e usa somente armazenamento local para as imagens. Os PDFs são criados com JPEGs incorporados no formato PDF 1.4 por JavaScript, evitando bibliotecas via CDN. Somente o navegador pode fazer requisições de aplicação e atualização dos arquivos estáticos.

## Licença

MIT — veja LICENSE.
