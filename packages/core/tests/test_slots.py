import json
import subprocess
import sys
import textwrap
import uuid
from collections.abc import Iterator
from pathlib import Path

import pytest

from ac_core import slots
from ac_core.slots import SlotError, SlotFinder

README = """---
title: Greeting
type: graded
slots:
  {module}: greeting.py
---

# Greeting
"""


def make_repo(root: Path, module: str) -> Path:
    """A repo with one graded step, `_t.1`, that slots `module` to greeting.py."""
    (root / "pyproject.toml").write_text("[project]\nname = 't'\n")
    problem = root / "exercises" / "_t" / "01.problem.greeting"
    problem.mkdir(parents=True)
    (problem / "README.mdx").write_text(README.format(module=module))
    (root / "exercises" / "_t" / "01.solution.greeting").mkdir()
    return root


def make_package(base: Path, package: str) -> None:
    """`<package>/sub/greeting.py`, the reference module, returning "reference"."""
    sub = base / package / "sub"
    sub.mkdir(parents=True)
    (base / package / "__init__.py").write_text("")
    (sub / "__init__.py").write_text("")
    (sub / "greeting.py").write_text("WHO = 'reference'\n")
    (sub / "other.py").write_text("WHO = 'reference'\n")


def write_slot(directory: Path, who: str = "slot") -> None:
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "greeting.py").write_text(f"WHO = {who!r}\n")


def test_read_frontmatter(tmp_path: Path) -> None:
    path = tmp_path / "README.mdx"
    path.write_text("---\ntitle: X\nhidden: true\n---\n\n# body\n---\n")
    assert slots.read_frontmatter(path) == {"title": "X", "hidden": True}


def test_read_frontmatter_without_block(tmp_path: Path) -> None:
    path = tmp_path / "README.mdx"
    path.write_text("# just a body\n")
    assert slots.read_frontmatter(path) == {}


@pytest.mark.parametrize(
    ("text", "error"),
    [("---\ntitle: X\n", "no closing"), ("---\n- a\n- b\n---\n", "must be a mapping")],
)
def test_read_frontmatter_rejects_bad_blocks(tmp_path: Path, text: str, error: str) -> None:
    path = tmp_path / "README.mdx"
    path.write_text(text)
    with pytest.raises(SlotError, match=error):
        slots.read_frontmatter(path)


def test_read_slots(tmp_path: Path) -> None:
    path = tmp_path / "README.mdx"
    path.write_text(README.format(module="a.b"))
    assert slots.read_slots(path) == {"a.b": "greeting.py"}


def test_read_slots_absent(tmp_path: Path) -> None:
    path = tmp_path / "README.mdx"
    path.write_text("---\ntitle: X\n---\n")
    assert slots.read_slots(path) == {}


@pytest.mark.parametrize("value", ["[a, b]", "{a: 1}"])
def test_read_slots_rejects_non_string_maps(tmp_path: Path, value: str) -> None:
    path = tmp_path / "README.mdx"
    path.write_text(f"---\nslots: {value}\n---\n")
    with pytest.raises(SlotError):
        slots.read_slots(path)


def test_find_step_dir(tmp_path: Path) -> None:
    root = make_repo(tmp_path, "m")
    section = root / "exercises" / "09.acls"
    (section / "02.problem.over-fetch").mkdir(parents=True)
    (section / "02.solution.over-fetch").mkdir()
    assert slots.find_step_dir(root, "09.2") == section / "02.problem.over-fetch"
    assert slots.find_step_dir(root, "09.2", "solution") == section / "02.solution.over-fetch"
    assert slots.find_step_dir(root, "_t.1") == root / "exercises/_t/01.problem.greeting"


@pytest.mark.parametrize("step", ["09.9", "10.1", "nope"])
def test_find_step_dir_unknown(tmp_path: Path, step: str) -> None:
    with pytest.raises(SlotError):
        slots.find_step_dir(make_repo(tmp_path, "m"), step)


def test_active_step_prefers_env_over_state(tmp_path: Path) -> None:
    (tmp_path / ".ex").mkdir()
    (tmp_path / ".ex" / "state.json").write_text(json.dumps({"active_step": "01.1"}))
    assert slots.resolve_active_step(tmp_path, {"AC_ACTIVE_STEP": "02.3"}) == "02.3"
    assert slots.resolve_active_step(tmp_path, {}) == "01.1"


@pytest.mark.parametrize("state", [None, "{}", '{"active_step": null}', "[]"])
def test_no_active_step(tmp_path: Path, state: str | None) -> None:
    if state is not None:
        (tmp_path / ".ex").mkdir()
        (tmp_path / ".ex" / "state.json").write_text(state)
    assert slots.resolve_active_step(tmp_path, {}) is None


def test_resolve_maps_modules_into_the_slot_root(tmp_path: Path) -> None:
    root = make_repo(tmp_path, "pkg.sub.greeting")
    env = {"AC_ACTIVE_STEP": "_t.1"}
    assert slots.resolve(root, env).slots == {"pkg.sub.greeting": root / "playground/greeting.py"}
    custom = slots.resolve(root, {**env, "AC_SLOT_ROOT": "exercises/_t/01.solution.greeting"})
    assert custom.slot_root == root / "exercises/_t/01.solution.greeting"
    absolute = slots.resolve(root, {**env, "AC_SLOT_ROOT": "/elsewhere"})
    assert absolute.slots == {"pkg.sub.greeting": Path("/elsewhere/greeting.py")}


def test_resolve_without_a_step(tmp_path: Path) -> None:
    resolution = slots.resolve(make_repo(tmp_path, "m"), {})
    assert resolution.step is None
    assert resolution.slots == {}


def test_find_repo_root_is_this_repo() -> None:
    root = slots.find_repo_root()
    assert (root / "exercises").is_dir()
    assert (root / "packages" / "core" / "src" / "ac_core" / "slots.py").is_file()


@pytest.fixture
def package(tmp_path: Path) -> Iterator[str]:
    """A throwaway reference package on sys.path, removed afterwards."""
    name = f"slotpkg_{uuid.uuid4().hex}"
    make_package(tmp_path / "src", name)
    sys.path.insert(0, str(tmp_path / "src"))
    yield name
    sys.path.remove(str(tmp_path / "src"))
    for module in [m for m in sys.modules if m.split(".")[0] == name]:
        del sys.modules[module]


@pytest.fixture
def finder() -> Iterator[list[SlotFinder]]:
    """Finders appended here are put on sys.meta_path and removed afterwards."""
    installed: list[SlotFinder] = []
    yield installed
    for f in installed:
        sys.meta_path.remove(f)


def use(finders: list[SlotFinder], module: str, file: Path) -> None:
    f = SlotFinder(slots.Resolution(step="_t.1", slot_root=file.parent, slots={module: file}))
    sys.meta_path.insert(0, f)
    finders.append(f)


def test_finder_swaps_a_nested_module(
    tmp_path: Path, package: str, finder: list[SlotFinder]
) -> None:
    write_slot(tmp_path / "playground")
    use(finder, f"{package}.sub.greeting", tmp_path / "playground" / "greeting.py")

    greeting = __import__(f"{package}.sub.greeting", fromlist=["WHO"])
    other = __import__(f"{package}.sub.other", fromlist=["WHO"])
    parent = sys.modules[f"{package}.sub"]

    assert greeting.WHO == "slot"
    assert greeting.__file__ == str(tmp_path / "playground" / "greeting.py")
    assert other.WHO == "reference"
    assert parent.__file__ is not None
    assert Path(parent.__file__).parent == tmp_path / "src" / package / "sub"
    assert parent.greeting is greeting


def test_finder_refuses_a_missing_slot_file(
    tmp_path: Path, package: str, finder: list[SlotFinder]
) -> None:
    use(finder, f"{package}.sub.greeting", tmp_path / "playground" / "greeting.py")
    with pytest.raises(ModuleNotFoundError, match=r"ex start _t\.1"):
        __import__(f"{package}.sub.greeting")


def run_python(code: str, *, cwd: Path, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-c", textwrap.dedent(code)],
        cwd=cwd,
        env={"PATH": "/usr/bin:/bin", "PYTHONPATH": str(cwd / "src"), **env},
        capture_output=True,
        text=True,
        check=False,
    )


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = make_repo(tmp_path, "refpkg.sub.greeting")
    make_package(root / "src", "refpkg")
    write_slot(root / "playground", "playground")
    write_slot(root / "exercises" / "_t" / "01.solution.greeting", "solution")
    return root


INSTALL = """
    import sys
    from pathlib import Path
    from ac_core.slots import install, SlotFinder
    first = install(root=Path.cwd())
    second = install(root=Path.cwd())
    assert first is second
    assert sum(isinstance(f, SlotFinder) for f in sys.meta_path) == 1
    assert isinstance(sys.meta_path[0], SlotFinder)
    from refpkg.sub import greeting, other
    print(greeting.WHO, other.WHO)
"""


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({}, "reference reference"),
        ({"AC_ACTIVE_STEP": "_t.1"}, "playground reference"),
        (
            {"AC_ACTIVE_STEP": "_t.1", "AC_SLOT_ROOT": "exercises/_t/01.solution.greeting"},
            "solution reference",
        ),
    ],
)
def test_install_in_a_fresh_process(repo: Path, env: dict[str, str], expected: str) -> None:
    result = run_python(INSTALL, cwd=repo, env=env)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == expected


def test_install_reads_the_state_file(repo: Path) -> None:
    (repo / ".ex").mkdir()
    (repo / ".ex" / "state.json").write_text(json.dumps({"active_step": "_t.1"}))
    result = run_python(INSTALL, cwd=repo, env={})
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "playground reference"


def test_install_resolves_once(repo: Path) -> None:
    code = """
        import os
        from pathlib import Path
        from ac_core.slots import install
        install(root=Path.cwd())
        os.environ["AC_SLOT_ROOT"] = "exercises/_t/01.solution.greeting"
        install(root=Path.cwd())
        from refpkg.sub import greeting
        print(greeting.WHO)
    """
    result = run_python(code, cwd=repo, env={"AC_ACTIVE_STEP": "_t.1"})
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "playground"


def test_install_after_the_slot_module_was_imported_fails(repo: Path) -> None:
    code = """
        from pathlib import Path
        import refpkg.sub.greeting
        from ac_core.slots import install
        install(root=Path.cwd())
    """
    result = run_python(code, cwd=repo, env={"AC_ACTIVE_STEP": "_t.1"})
    assert result.returncode != 0
    assert "install() ran after slot modules were imported: refpkg.sub.greeting" in result.stderr


def test_install_with_an_unknown_step_fails(repo: Path) -> None:
    result = run_python(INSTALL, cwd=repo, env={"AC_ACTIVE_STEP": "99.1"})
    assert result.returncode != 0
    assert "no problem directory for step 99.1" in result.stderr
