-- Diff Leppard for Neovim: run the diff-leppard CLI and show its findings as diagnostics and in the
-- quickfix list. All model and GitHub settings come from the CLI's own config
-- (~/.config/diff-leppard/config.json, DIFF_LEPPARD_* variables, .diff-leppard.json); this plugin
-- only decides how results are shown.
local M = {}

local defaults = {
  -- The CLI to run. A list, so it can be e.g. { "npx", "diff-leppard" } or { "node", "/path/dist/cli.js" }.
  cmd = { "diff-leppard" },
  -- Extra arguments for every review, e.g. { "--model", "qwen2.5-coder:32b" }.
  args = {},
  -- Show findings as vim.diagnostic entries in the files they point at.
  diagnostics = true,
  -- Put findings in the quickfix list (and open it when there are any).
  quickfix = true,
  open_quickfix = true,
  -- Findings below this severity are left out: "critical", "major", "minor" or "nit".
  minimum_severity = "nit",
}

M.config = vim.deepcopy(defaults)
M.ns = vim.api.nvim_create_namespace("diff-leppard")

local SEVERITY_RANK = { critical = 1, major = 2, minor = 3, nit = 4 }
local DIAG_SEVERITY = {
  critical = vim.diagnostic.severity.ERROR,
  major = vim.diagnostic.severity.ERROR,
  minor = vim.diagnostic.severity.WARN,
  nit = vim.diagnostic.severity.HINT,
}
local QF_TYPE = { critical = "E", major = "E", minor = "W", nit = "N" }

---@type vim.SystemObj?
local job
---@type table? The last ReviewResult, for :DiffLeppardShow.
M.last = nil

function M.setup(opts)
  M.config = vim.tbl_deep_extend("force", vim.deepcopy(defaults), opts or {})
end

local function notify(msg, level)
  vim.notify("Diff Leppard: " .. msg, level or vim.log.levels.INFO)
end

--- The git repo root for the current buffer's directory (or the cwd), or nil.
local function repo_root()
  local name = vim.api.nvim_buf_get_name(0)
  local dir = (name ~= "" and vim.fn.isdirectory(vim.fs.dirname(name)) == 1) and vim.fs.dirname(name) or vim.fn.getcwd()
  local out = vim.system({ "git", "-C", dir, "rev-parse", "--show-toplevel" }, { text = true }):wait()
  if out.code ~= 0 then return nil end
  return vim.trim(out.stdout)
end

--- Clear findings from every buffer and the quickfix list (if it's ours).
function M.clear()
  vim.diagnostic.reset(M.ns)
  local qf = vim.fn.getqflist({ title = 0 })
  if qf.title and qf.title:find("^Diff Leppard") then vim.fn.setqflist({}, "r", { title = "Diff Leppard", items = {} }) end
end

--- Turn a finding into the message shown in diagnostics and the quickfix list.
local function message(f)
  local parts = { (f.title ~= "" and f.title or "Finding") }
  if f.body and f.body ~= "" then table.insert(parts, f.body) end
  if f.suggestion and f.suggestion ~= "" then table.insert(parts, "Suggested change:\n" .. f.suggestion) end
  if f.lineAdjusted then table.insert(parts, "(location approximate)") end
  return table.concat(parts, "\n\n")
end

--- Show a ReviewResult. `root` is the repo root the finding paths are relative to.
function M.show(result, root)
  M.clear()
  local cfg = M.config
  local min = SEVERITY_RANK[cfg.minimum_severity] or 4
  local by_buf, items = {}, {}
  for _, f in ipairs(result.findings or {}) do
    local sev = SEVERITY_RANK[f.severity] and f.severity or "minor"
    if SEVERITY_RANK[sev] <= min then
      local path = root and vim.fs.joinpath(root, f.file) or f.file
      local lnum = math.max((tonumber(f.line) or 1) - 1, 0)
      local end_lnum = math.max((tonumber(f.endLine) or (lnum + 1)) - 1, lnum)
      local text = message(f)
      if cfg.diagnostics and vim.uv.fs_stat(path) then
        local buf = vim.fn.bufadd(path)
        by_buf[buf] = by_buf[buf] or {}
        table.insert(by_buf[buf], {
          lnum = lnum,
          end_lnum = end_lnum,
          col = 0,
          severity = DIAG_SEVERITY[sev],
          source = "diff-leppard",
          code = f.category,
          message = string.format("[%s] %s", sev, text),
        })
      end
      table.insert(items, {
        filename = path,
        lnum = lnum + 1,
        end_lnum = end_lnum + 1,
        type = QF_TYPE[sev],
        text = string.format("[%s] %s", sev, (text:gsub("\n+", " "))),
      })
    end
  end
  for buf, diags in pairs(by_buf) do
    vim.diagnostic.set(M.ns, buf, diags)
  end
  if cfg.quickfix then
    vim.fn.setqflist({}, " ", { title = "Diff Leppard: " .. (result.model or "review"), items = items })
    if cfg.open_quickfix and #items > 0 then vim.cmd("botright copen") end
  end
  return #items
end

local function count_line(result)
  local counts, order = {}, { "critical", "major", "minor", "nit" }
  for _, f in ipairs(result.findings or {}) do counts[f.severity] = (counts[f.severity] or 0) + 1 end
  local out = {}
  for _, s in ipairs(order) do
    if counts[s] then table.insert(out, counts[s] .. " " .. s) end
  end
  return #out > 0 and table.concat(out, ", ") or "no issues found"
end

--- Run a review. `args` are the CLI arguments after the command name, e.g. { "local", "--staged" }.
function M.review(args)
  if job then
    notify("a review is already running (:DiffLeppardCancel to stop it)", vim.log.levels.WARN)
    return
  end
  local root = repo_root()
  if not root then
    notify("not in a git repository", vim.log.levels.ERROR)
    return
  end
  local cmd = vim.list_extend(vim.deepcopy(M.config.cmd), args)
  vim.list_extend(cmd, M.config.args)
  vim.list_extend(cmd, { "-q", "-f", "json" })
  if args[1] == "pr" then table.insert(cmd, "--no-prompt") end

  local what = table.concat(args, " ")
  notify("reviewing (" .. what .. ")…")
  local started = vim.uv.now()
  local ok, obj = pcall(vim.system, cmd, { cwd = root, text = true }, function(out)
    vim.schedule(function()
      job = nil
      if out.signal == 15 or out.signal == 9 then
        notify("cancelled", vim.log.levels.WARN)
        return
      end
      local decoded, result = pcall(vim.json.decode, out.stdout or "", { luanil = { object = true, array = true } })
      if not decoded or type(result) ~= "table" then
        local err = vim.trim(out.stderr or "")
        notify("review failed" .. (err ~= "" and (":\n" .. err) or (" (exit " .. out.code .. ")")), vim.log.levels.ERROR)
        return
      end
      M.last = result
      M.last_root = root
      M.show(result, root)
      local secs = math.floor((vim.uv.now() - started) / 100) / 10
      local msg = string.format("%s · %s · %ss", count_line(result), result.model or "?", secs)
      local level = vim.log.levels.INFO
      if result.errors and #result.errors > 0 then
        msg = msg .. "\nIncomplete review: " .. table.concat(result.errors, "; ")
        level = vim.log.levels.WARN
      end
      notify(msg, level)
    end)
  end)
  if not ok then
    notify("could not run " .. M.config.cmd[1] .. ": " .. tostring(obj) .. " (see :checkhealth diff-leppard)", vim.log.levels.ERROR)
    return
  end
  job = obj
end

function M.cancel()
  if not job then
    notify("no review is running")
    return
  end
  job:kill(15)
end

function M.running()
  return job ~= nil
end

return M
