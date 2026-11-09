-- :checkhealth diff-leppard
local M = {}

function M.check()
  local h = vim.health
  h.start("diff-leppard")
  if vim.fn.has("nvim-0.10") == 0 then
    h.error("Neovim 0.10 or newer is required (vim.system)")
    return
  end
  local cmd = require("diff-leppard").config.cmd
  if vim.fn.executable(cmd[1]) == 0 then
    h.error(
      ("`%s` not found on PATH"):format(cmd[1]),
      { "Install the CLI: npm install -g https://github.com/georgestephanis/diff-leppard/releases/latest/download/diff-leppard.tgz",
        'Or point the plugin at it: require("diff-leppard").setup({ cmd = { "node", "/path/to/diff-leppard/dist/cli.js" } })' }
    )
    return
  end
  local version = vim.system(vim.list_extend(vim.deepcopy(cmd), { "--version" }), { text = true }):wait()
  if version.code ~= 0 then
    h.error("`" .. table.concat(cmd, " ") .. " --version` failed: " .. vim.trim(version.stderr or ""))
    return
  end
  h.ok("CLI " .. vim.trim(version.stdout) .. " (" .. table.concat(cmd, " ") .. ")")

  local test = vim.system(vim.list_extend(vim.deepcopy(cmd), { "test" }), { text = true }):wait(60000)
  local out = vim.trim((test.stdout or "") .. "\n" .. (test.stderr or ""))
  if test.code == 0 then
    h.ok("Model server: " .. (out:match("[^\n]*replied[^\n]*") or "reachable"))
  else
    h.warn("Model server check failed:\n" .. out, { "Run `diff-leppard config` to see the effective settings and where they came from" })
  end
end

return M
