use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub description: String,
    pub source: String, // "commands", "agents", "skills"
    pub content: String,
    pub path: String,
}

fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>, String) {
    let trimmed = text.trim_start();
    if !trimmed.starts_with("---") {
        return (None, None, text.to_string());
    }

    let after_first = &trimmed[3..];
    let after_first = after_first.trim_start_matches(['\n', '\r']);

    if let Some(end_idx) = after_first.find("\n---") {
        let yaml_block = &after_first[..end_idx];
        let content = &after_first[end_idx + 4..];
        let content = content.trim_start_matches(['\n', '\r']);

        let mut name = None;
        let mut description = None;

        for line in yaml_block.lines() {
            let line = line.trim();
            if let Some(val) = line.strip_prefix("name:") {
                name = Some(val.trim().trim_matches('"').trim_matches('\'').to_string());
            } else if let Some(val) = line.strip_prefix("description:") {
                description =
                    Some(val.trim().trim_matches('"').trim_matches('\'').to_string());
            }
        }

        (name, description, content.to_string())
    } else {
        (None, None, text.to_string())
    }
}

/// Derive a readable name from a plugin path.
/// e.g. `.../plugins/cache/context-engineering-kit/kaizen/1.0.0/skills/root-cause-tracing/SKILL.md`
///   → name: "kaizen:root-cause-tracing", source: "kaizen"
/// e.g. `.../plugins/cache/context-engineering-kit/code-review/1.0.8/agents/bug-hunter.md`
///   → name: "code-review:bug-hunter", source: "code-review"
fn derive_plugin_info(path: &std::path::Path) -> (String, String) {
    let components: Vec<&str> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str())
        .collect();

    // Find "plugins" → "cache" → publisher → plugin_name → version → type → ...
    if let Some(cache_idx) = components.iter().position(|&c| c == "cache") {
        let plugin_name = components.get(cache_idx + 2).unwrap_or(&"unknown");

        // For skills: .../skills/<skill-name>/SKILL.md → use parent dir name
        // For agents: .../agents/<agent-name>.md → use file stem
        if let Some(type_idx) = components.iter().rposition(|&c| c == "skills" || c == "agents") {
            let item_name = if components.get(components.len() - 1) == Some(&"SKILL.md") {
                // Parent directory is the skill name
                components.get(components.len() - 2).unwrap_or(&"unknown")
            } else {
                // File stem is the name
                path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
            };
            let _ = type_idx; // used for pattern matching above
            return (
                format!("{}:{}", plugin_name, item_name),
                plugin_name.to_string(),
            );
        }
    }

    let stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("unknown");
    (stem.to_string(), "other".to_string())
}

fn scan_glob(dir: &PathBuf, pattern: &str, default_source: &str, use_plugin_names: bool) -> Vec<SkillEntry> {
    let mut entries = Vec::new();

    let full_pattern = dir.join(pattern).to_string_lossy().to_string();
    let paths = glob::glob(&full_pattern).unwrap_or_else(|_| glob::glob("").unwrap());

    for path in paths.flatten() {
        if let Ok(text) = fs::read_to_string(&path) {
            let (fm_name, description, content) = parse_frontmatter(&text);

            let (derived_name, derived_source) = if use_plugin_names {
                derive_plugin_info(&path)
            } else {
                let stem = path.file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                (stem, default_source.to_string())
            };

            // For plugins, always use the derived name (plugin:item format).
            // For user commands/agents, prefer frontmatter name.
            let name = if use_plugin_names {
                derived_name
            } else {
                fm_name.unwrap_or(derived_name)
            };

            entries.push(SkillEntry {
                name,
                description: description.unwrap_or_default(),
                source: derived_source,
                content,
                path: path.to_string_lossy().to_string(),
            });
        }
    }

    entries
}

#[tauri::command]
pub fn scan_skills() -> Vec<SkillEntry> {
    let mut all = Vec::new();

    let Some(home) = dirs::home_dir() else {
        return all;
    };

    let claude_dir = home.join(".claude");

    // User commands: ~/.claude/commands/*.md
    all.extend(scan_glob(&claude_dir, "commands/*.md", "commands", false));

    // User agents: ~/.claude/agents/*.md
    all.extend(scan_glob(&claude_dir, "agents/*.md", "agents", false));

    // Plugin skills: plugins/cache/<publisher>/<plugin>/<version>/skills/**/*.md
    all.extend(scan_glob(&claude_dir, "plugins/cache/*/*/*/skills/**/*.md", "skills", true));

    // Plugin agents: plugins/cache/<publisher>/<plugin>/<version>/agents/*.md
    all.extend(scan_glob(&claude_dir, "plugins/cache/*/*/*/agents/*.md", "agents", true));

    all
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_parse_frontmatter_valid() {
        let text = "---\nname: test-skill\ndescription: A test\n---\nSome content here";
        let (name, desc, content) = parse_frontmatter(text);
        assert_eq!(name.unwrap(), "test-skill");
        assert_eq!(desc.unwrap(), "A test");
        assert_eq!(content, "Some content here");
    }

    #[test]
    fn test_parse_frontmatter_no_frontmatter() {
        let text = "Just plain content";
        let (name, desc, content) = parse_frontmatter(text);
        assert!(name.is_none());
        assert!(desc.is_none());
        assert_eq!(content, "Just plain content");
    }

    #[test]
    fn test_parse_frontmatter_quoted_values() {
        let text = "---\nname: \"quoted-name\"\ndescription: 'quoted desc'\n---\nBody";
        let (name, desc, content) = parse_frontmatter(text);
        assert_eq!(name.unwrap(), "quoted-name");
        assert_eq!(desc.unwrap(), "quoted desc");
        assert_eq!(content, "Body");
    }

    #[test]
    fn test_scan_glob_with_temp() {
        let tmp = std::env::temp_dir().join("agent-flow-test-skills");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("commands")).unwrap();

        fs::write(
            tmp.join("commands/test.md"),
            "---\nname: my-cmd\ndescription: Does things\n---\nRun this command",
        )
        .unwrap();

        let results = scan_glob(&tmp, "commands/*.md", "commands", false);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "my-cmd");
        assert_eq!(results[0].description, "Does things");
        assert_eq!(results[0].content, "Run this command");
        assert_eq!(results[0].source, "commands");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_derive_plugin_info_skill() {
        let path = std::path::Path::new("/Users/george/.claude/plugins/cache/context-engineering-kit/kaizen/1.0.0/skills/root-cause-tracing/SKILL.md");
        let (name, source) = derive_plugin_info(path);
        assert_eq!(name, "kaizen:root-cause-tracing");
        assert_eq!(source, "kaizen");
    }

    #[test]
    fn test_derive_plugin_info_agent() {
        let path = std::path::Path::new("/Users/george/.claude/plugins/cache/context-engineering-kit/code-review/1.0.8/agents/bug-hunter.md");
        let (name, source) = derive_plugin_info(path);
        assert_eq!(name, "code-review:bug-hunter");
        assert_eq!(source, "code-review");
    }
}
