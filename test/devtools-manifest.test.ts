// D1-07: the DevTools panel is a real MV3 extension with zero permissions. Written before the
// extension existed (red-D1-07.log).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoDir } from './helpers';

const dir = resolve(repoDir, 'devtools');
const read = (f: string) => readFileSync(resolve(dir, f), 'utf8');

const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

describe('devtools/manifest.json', () => {
  const m = () => JSON.parse(read('manifest.json')) as Record<string, unknown>;

  it('is exactly the architect decided manifest: MV3, devtools_page, Chrome 120, the strict extension CSP', () => {
    expect(m()).toEqual({
      manifest_version: 3,
      name: 'Airplane Mode runtime events',
      version: '0.1.0',
      description: expect.any(String),
      devtools_page: 'devtools.html',
      minimum_chrome_version: '120',
      content_security_policy: { extension_pages: CSP },
    });
    expect((m()['description'] as string).length).toBeGreaterThan(20);
    expect((m()['description'] as string).length).toBeLessThanOrEqual(132);
  });

  it('declares no permissions, host_permissions, content_scripts, background, web_accessible_resources or externally_connectable', () => {
    const keys = Object.keys(m());
    for (const forbidden of [
      'permissions',
      'optional_permissions',
      'host_permissions',
      'optional_host_permissions',
      'content_scripts',
      'background',
      'web_accessible_resources',
      'externally_connectable',
      'commands',
      'omnibox',
      'action',
      'options_page',
      'sandbox',
    ])
      expect(keys, forbidden).not.toContain(forbidden);
  });

  it('the extension CSP carries connect-src none, script-src self and no unsafe-inline, unsafe-eval or wasm-unsafe-eval', () => {
    const csp = (m()['content_security_policy'] as { extension_pages: string }).extension_pages;
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|wasm-unsafe-eval|\*|https?:|data:|blob:/);
  });
});

describe('devtools pages and sources', () => {
  for (const page of ['devtools.html', 'panel.html']) {
    it(`${page}: only external scripts and styles, no inline script or style, no event handler attributes, relative references only`, () => {
      const html = read(page);
      for (const m of html.matchAll(/<script\b([^>]*)>/gi)) expect(m[1], page).toMatch(/\ssrc=/);
      expect(html).not.toMatch(/<script\b[^>]*>\s*[^<\s]/i); // a script element with a body
      expect(html).not.toMatch(/<style\b/i);
      expect(html).not.toMatch(/\sstyle\s*=/i);
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html).not.toMatch(
        /(src|href|action)\s*=\s*["'](https?:|\/\/|data:|javascript:|blob:)/i,
      );
      expect(html).toContain('<meta charset="utf-8"');
    });
  }

  function walk(d: string): string[] {
    return readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? (f === 'dist' ? [] : walk(p)) : [p];
    });
  }

  it('no innerHTML, insertAdjacentHTML, outerHTML, document.write, eval or new Function under devtools/src', () => {
    const files = walk(resolve(dir, 'src')).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const f of files) {
      const code = readFileSync(f, 'utf8')
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      const where = relative(repoDir, f);
      expect(code, where).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
      // inspectedWindow.eval is the DevTools API; a bare eval() or a Function constructor is not allowed
      expect(code, where).not.toMatch(
        /(^|[^.\w])eval\s*\(|new\s+Function\b|(^|[^.\w])Function\s*\(/,
      );
      expect(code, where).not.toMatch(
        /\bfetch\s*\(|XMLHttpRequest|WebSocket|importScripts|sendBeacon/,
      );
    }
  });

  it('the single page expression is a constant: panel.ts passes only CONST_EXPR to inspectedWindow.eval', () => {
    const panel = read('src/panel.ts');
    const controller = read('src/controller.ts');
    for (const text of [panel, controller])
      for (const m of text.matchAll(/\.eval\s*\(\s*([^,)\s]+)/g))
        expect(m[1], 'argument of an eval call').toMatch(/^(PAGE_EXPRESSION|expr)$/);
    expect(read('src/page-expr.ts')).toContain('export const PAGE_EXPRESSION');
    // no useContentScriptContext, no frameURL: the expression runs in the page's main frame
    expect(read('src/controller.ts') + panel).not.toMatch(
      /useContentScriptContext|frameURL|scriptExecutionContext/,
    );
  });

  it('the unsafe-extension-debugging flag appears in test files only', () => {
    const roots = [
      'README.md',
      'package.json',
      'CONTRIBUTING.md',
      'devtools',
      'demo',
      'docs',
      'scripts',
      'src',
      'spec',
      '.github',
    ];
    const hits: string[] = [];
    const scan = (p: string): void => {
      if (!existsSync(p)) return;
      if (statSync(p).isDirectory()) {
        for (const f of readdirSync(p)) if (f !== 'dist' && f !== 'node_modules') scan(join(p, f));
      } else if (/enable-unsafe-extension-debugging/.test(readFileSync(p, 'utf8')))
        hits.push(relative(repoDir, p));
    };
    for (const r of roots) scan(resolve(repoDir, r));
    expect(hits).toEqual([]);
    // and the browser test that needs it does carry it
    expect(readFileSync(resolve(repoDir, 'test/browser/devtools.spec.ts'), 'utf8')).toContain(
      '--enable-unsafe-extension-debugging',
    );
  });

  it('the README gives the install steps without the debugging flag', () => {
    const readme = read('README.md');
    for (const step of [
      'npm run devtools:build',
      'chrome://extensions',
      'Developer mode',
      'Load unpacked',
      'devtools/dist',
      'exposeDevtoolsHook',
      'Airplane Mode',
    ])
      expect(readme, step).toContain(step);
    expect(readme).not.toContain('unsafe-extension-debugging');
    expect(readme).toContain('Chrome Web Store');
  });

  it('build output is not tracked: devtools/dist is ignored and not in the npm tarball list', () => {
    expect(readFileSync(resolve(repoDir, '.gitignore'), 'utf8')).toMatch(/devtools\/dist\//);
    const pkg = JSON.parse(readFileSync(resolve(repoDir, 'package.json'), 'utf8')) as {
      files: string[];
      scripts: Record<string, string>;
    };
    expect(pkg.files).not.toContain('devtools');
    expect(pkg.scripts['devtools:build']).toBeDefined();
  });
});
