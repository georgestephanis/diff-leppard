-- Diff Leppard user commands. The module loads on first use, so this file costs nothing at startup.
if vim.g.loaded_diff_leppard then return end
vim.g.loaded_diff_leppard = true

local function dl() return require("diff-leppard") end

local command = vim.api.nvim_create_user_command

command("DiffLeppard", function(o)
  dl().review(vim.list_extend({ "local" }, o.fargs))
end, { nargs = "*", desc = "Diff Leppard: review uncommitted changes (extra args go to `diff-leppard local`, e.g. --base main)" })

command("DiffLeppardStaged", function(o)
  dl().review(vim.list_extend({ "local", "--staged" }, o.fargs))
end, { nargs = "*", desc = "Diff Leppard: review staged changes" })

command("DiffLeppardPR", function(o)
  dl().review(vim.list_extend({ "pr" }, o.fargs))
end, { nargs = "*", desc = "Diff Leppard: review a GitHub PR (number, URL or owner/repo#n; default: this branch's PR)" })

command("DiffLeppardCancel", function() dl().cancel() end, { desc = "Diff Leppard: cancel the running review" })

command("DiffLeppardClear", function() dl().clear() end, { desc = "Diff Leppard: clear findings" })

command("DiffLeppardShow", function()
  local m = dl()
  if not m.last then return vim.notify("Diff Leppard: no review yet", vim.log.levels.INFO) end
  m.show(m.last, m.last_root)
end, { desc = "Diff Leppard: show the last review's findings again" })
