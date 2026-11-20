/**
 * 文件能力：读原件（越界/不在都给说法）、转 PDF（pdf 直回、office 走转换，用假 soffice 验证编排）、
 * 另存、@ 补全（隐藏目录跳过、深度与数量上限、带空格加引号）、拖入转 @ 路径（文件夹外的不带）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { convertToPdf, OfficeError } from '../src/main/office.mjs'
import { createFileOps } from '../src/main/files.mjs'
import { createFolders } from '../src/main/folders.mjs'

const PDF_HEAD = '%PDF-1.4 stub'

async function makeWorld() {
  const dir = mkdtempSync(join(tmpdir(), 'kw-files-'))
  const folder = join(dir, '工作 文件夹')
  mkdirSync(folder, { recursive: true })
  mkdirSync(join(folder, '2025'))
  writeFileSync(join(folder, '2025', '完成率.xlsx'), 'xlsx-bytes')
  writeFileSync(join(folder, 'notes.md'), '# 笔记')
  writeFileSync(join(folder, '报价 单.pdf'), PDF_HEAD)
  mkdirSync(join(folder, '.git'), { recursive: true })
  writeFileSync(join(folder, '.git', 'hidden'), 'h')
  const folders = createFolders({ file: join(dir, 'folders.json') })
  await folders.set('c_1', folder)
  const office = {
    calls: [],
    async convertToPdf(source) {
      this.calls.push(source)
      return Buffer.from(PDF_HEAD)
    },
  }
  const fileOps = createFileOps({ folders, office })
  return { dir, folder, folders, office, fileOps }
}

test('读原件：工作文件夹内的照读，越界与不在都给说法', async () => {
  const { dir, fileOps } = await makeWorld()
  try {
    const bytes = await fileOps.read('c_1', '2025/完成率.xlsx')
    assert.equal(bytes.toString(), 'xlsx-bytes')
    await assert.rejects(fileOps.read('c_1', '../../etc/passwd'), /不在工作文件夹/)
    await assert.rejects(fileOps.read('c_1', '2025/没有.md'), /文件不在了/)
    await assert.rejects(fileOps.read('c_9', 'notes.md'), /没有工作文件夹/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('转 PDF：pdf 原件直接回，别的走转换引擎', async () => {
  const { dir, fileOps, office } = await makeWorld()
  try {
    const pdfBytes = await fileOps.pdf('c_1', '报价 单.pdf')
    assert.equal(pdfBytes.toString(), PDF_HEAD)
    assert.equal(office.calls.length, 0, 'PDF 不用再转')
    const converted = await fileOps.pdf('c_1', 'notes.md')
    assert.equal(converted.toString(), PDF_HEAD)
    assert.deepEqual(office.calls, [join(dir, '工作 文件夹', 'notes.md')])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('另存与打开：对话框与 shell 注入', async () => {
  const { dir, office } = await makeWorld()
  try {
    const folders = createFolders({ file: join(dir, 'folders.json') })
    await folders.set('c_1', join(dir, '工作 文件夹'))
    const openCalls = []
    const fileOps = createFileOps({
      folders,
      office,
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: join(dir, '另存.pdf') }) },
      shell: {
        openPath: async () => '',
        showItemInFolder: () => openCalls.push('reveal'),
      },
    })
    const saved = await fileOps.save('c_1', 'notes.md')
    assert.equal(saved.saved, true)
    assert.ok(existsSync(join(dir, '另存.pdf')), '另存真的把文件复制过去了')
    await fileOps.open('c_1', 'notes.md', 'reveal')
    assert.deepEqual(openCalls, ['reveal'])
    const canceled = createFileOps({
      folders,
      office,
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      shell: { openPath: async () => '', showItemInFolder: () => {} },
    })
    assert.deepEqual(await canceled.save('c_1', 'notes.md'), { saved: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('@ 补全：隐藏目录跳过、带空格的路径加引号、按查找词筛', async () => {
  const { dir, fileOps } = await makeWorld()
  try {
    const all = await fileOps.references('c_1', '')
    const paths = all.map(reference => reference.path)
    assert.ok(paths.includes('2025/完成率.xlsx') && paths.includes('notes.md'))
    assert.ok(!paths.some(path => path.includes('.git')), '隐藏目录不进补全')
    const quoted = all.find(reference => reference.path === '报价 单.pdf')
    assert.equal(quoted.insert, '"报价 单.pdf"', '带空格的加引号')
    assert.equal(all.find(reference => reference.path === '2025/完成率.xlsx').insert, '2025/完成率.xlsx')
    assert.equal(all.find(reference => reference.path === '2025').kind, 'directory')
    const filtered = await fileOps.references('c_1', '完成率')
    assert.ok(filtered.length > 0 && filtered.every(reference => reference.path.includes('完成率')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('拖入转 @ 路径：文件夹外的跳过不外带', async () => {
  const { dir, fileOps } = await makeWorld()
  try {
    const result = await fileOps.mentionsForPaths('c_1', [
      join(dir, '工作 文件夹', 'notes.md'),
      join(dir, '工作 文件夹', '2025', '完成率.xlsx'),
      '/etc/passwd',
    ])
    assert.deepEqual(result.mentions, ['@notes.md', '@2025/完成率.xlsx'])
    assert.deepEqual(result.skipped, ['/etc/passwd'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('Office 转换的编排：假 soffice 产出即收，跑挂了给 OfficeError', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kw-office-'))
  try {
    const source = join(dir, '简报.docx')
    writeFileSync(source, 'docx-bytes')
    // 假 soffice：shell 脚本，把源文件对应的 PDF 写到 --outdir 里（编排只管调它、定位产出）
    const stub = join(dir, 'fake-soffice.sh')
    writeFileSync(stub, `#!/bin/sh
outdir=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--outdir" ]; then outdir="$arg"; fi
  prev="$arg"
done
for arg in "$@"; do
  source="$arg"
done
base=$(basename "$source")
base="\${base%.*}.pdf"
printf '%s' '${PDF_HEAD}' > "$outdir/$base"
`)
    chmodSync(stub, 0o755)
    const bytes = await convertToPdf(source, { sofficePath: stub, timeoutMs: 30_000 })
    assert.equal(bytes.toString(), PDF_HEAD)
    // 引擎不存在：转不成，给 OfficeError
    await assert.rejects(convertToPdf(source, { sofficePath: join(dir, '没有这个程序') }), OfficeError)
    assert.ok(existsSync(source), '源文件不该被动')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
