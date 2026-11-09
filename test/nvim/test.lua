-- Headless tests for the Neovim plugin. Run: nvim --headless -u NONE -l test/nvim/test.lua
-- Uses a fake CLI (a shell script that prints a fixed ReviewResult) in a temporary git repo.
local here = vim.fs.dirname(vim.fs.abspath(debug.getinfo(1, "S").source:sub(2)))
local repo_dir = vim.fs.dirname(vim.fs.dirname(here))
vim.opt.rtp:prepend(repo_dir)
vim.cmd("runtime plugin/diff-leppard.lua")

local failures = 0
local function check(cond, msg)
  if cond then
    io.stdout:write("ok   " .. msg .. "\n")
  else
    failures = failures + 1
    io.stdout:write("FAIL " .. msg .. "\n")
  end
end

-- A temp repo with one file.
local tmp = vim.fn.tempname()
vim.fn.mkdir(tmp .. "/src", "p")
vim.fn.writefile({ "local x = 1", "for i = 0, #xs do", "  use(xs[i])", "end" }, tmp .. "/src/loop.lua")
vim.system({ "git", "init", "-q", tmp }):wait()

-- Fake CLI: records its arguments and prints a fixed result.
local result = {
  summary = "Off-by-one.",
  model = "fake-model",
  findings = {
    { file = "src/loop.lua", line = 2, endLine = 3, severity = "major", category = "bug", title = "Off by one", body = "Lua arrays start at 1.", suggestion = "for i = 1, #xs do", inline = true },
    { file = "src/loop.lua", line = 1, severity = "nit", category = "style", title = "Name", body = "Use a clearer name.", inline = true },
    { file = "src/gone.lua", line = 5, severity = "minor", category = "bug", title = "Elsewhere", body = "Not on disk.", inline = false },
  },
  skippedFiles = {}, errors = {},
}
local fake = tmp .. "/fake-cli"
local args_file = tmp .. "/args"
local json_file = tmp .. "/result.json"
vim.fn.writefile({ vim.json.encode(result) }, json_file)
vim.fn.writefile({
  "#!/bin/sh",
  'printf "%s\\n" "$@" > ' .. vim.fn.shellescape(args_file),
  'if [ "$1" = slow ]; then sleep 30; fi',
  "cat " .. vim.fn.shellescape(json_file),
}, fake)
vim.fn.setfperm(fake, "rwxr-xr-x")

local dl = require("diff-leppard")
dl.setup({ cmd = { fake }, args = { "--model", "m" } })
vim.cmd("edit " .. tmp .. "/src/loop.lua")

local function wait_done()
  return vim.wait(10000, function() return not dl.running() end, 20)
end

-- :DiffLeppard
vim.cmd("DiffLeppard --base main")
check(dl.running(), "review runs in the background")
check(wait_done(), "review finishes")
local args = vim.fn.readfile(args_file)
check(vim.deep_equal(args, { "local", "--base", "main", "--model", "m", "-q", "-f", "json" }), "CLI args: " .. table.concat(args, " "))

local buf = vim.fn.bufnr(tmp .. "/src/loop.lua")
local diags = vim.diagnostic.get(buf, { namespace = dl.ns })
table.sort(diags, function(a, b) return a.lnum < b.lnum end)
check(#diags == 2, "two diagnostics in loop.lua (got " .. #diags .. ")")
check(diags[2] and diags[2].lnum == 1 and diags[2].end_lnum == 2, "line numbers are 0-based, with the end line")
check(diags[2] and diags[2].severity == vim.diagnostic.severity.ERROR, "major → ERROR")
check(diags[1] and diags[1].severity == vim.diagnostic.severity.HINT, "nit → HINT")
check(diags[2] and diags[2].message:find("Suggested change", 1, true) ~= nil, "suggestion in the message")

local qf = vim.fn.getqflist({ items = 0, title = 0 })
check(#qf.items == 3, "all three findings in quickfix (got " .. #qf.items .. ")")
check(qf.title == "Diff Leppard: fake-model", "quickfix title")
check(vim.fn.getwininfo(vim.fn.win_getid(vim.fn.winnr("$")))[1].quickfix == 1, "quickfix window opened")

-- minimum_severity
dl.setup({ cmd = { fake }, minimum_severity = "minor", open_quickfix = false })
dl.show(dl.last, dl.last_root)
check(#vim.fn.getqflist() == 2, "minimum_severity = minor drops the nit")

-- :DiffLeppardPR passes --no-prompt
vim.cmd("DiffLeppardPR 42")
wait_done()
args = vim.fn.readfile(args_file)
check(args[1] == "pr" and args[2] == "42" and vim.tbl_contains(args, "--no-prompt"), "PR args: " .. table.concat(args, " "))

-- :DiffLeppardClear
vim.cmd("DiffLeppardClear")
check(#vim.diagnostic.get(buf, { namespace = dl.ns }) == 0, "clear removes diagnostics")
check(#vim.fn.getqflist() == 0, "clear empties our quickfix list")

-- Cancel
dl.review({ "slow" })
check(dl.running(), "slow review running")
vim.cmd("DiffLeppardCancel")
check(wait_done(), "cancel stops it")

-- Missing CLI fails cleanly
local msgs = {}
local orig = vim.notify
vim.notify = function(m) table.insert(msgs, m) end
dl.setup({ cmd = { tmp .. "/does-not-exist" } })
vim.cmd("DiffLeppard")
wait_done()
vim.notify = orig
check(not dl.running() and msgs[#msgs]:find("could not run", 1, true) ~= nil, "missing CLI: " .. tostring(msgs[#msgs]))

vim.fn.delete(tmp, "rf")
io.stdout:write(failures == 0 and "\nall passed\n" or ("\n" .. failures .. " failed\n"))
os.exit(failures == 0 and 0 or 1)
