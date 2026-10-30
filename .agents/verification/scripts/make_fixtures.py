#!/usr/bin/env python3
"""Generates synthetic fixtures: fake provider keys in text cases and dashboard screenshots.

Every value is random and fake; none is a real credential. Output is deterministic (fixed seed).
Run from the repository root: python3 .agents/verification/scripts/make_fixtures.py
"""
import json
import random
import string
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

FIXTURES = Path(__file__).resolve().parents[1] / 'fixtures'
ALNUM = string.ascii_letters + string.digits
rng = random.Random(20261030)


def pick(alphabet: str, count: int) -> str:
    return ''.join(rng.choice(alphabet) for _ in range(count))


FAMILIES = {
    'cloudflare': lambda: 'cfut_' + pick(ALNUM, 40),
    'neon': lambda: 'npg_' + pick(ALNUM, 16),
    'google-oauth-client-secret': lambda: 'GOCSPX-' + pick(ALNUM + '_-', 28),
    'google-access-token': lambda: 'ya29.' + pick(ALNUM + '_-', 120),
    'github-pat': lambda: 'ghp_' + pick(ALNUM, 36),
    'github-fine-grained': lambda: 'github_pat_' + pick(ALNUM + '_', 82),
    'anthropic': lambda: 'sk-ant-api03-' + pick(ALNUM + '_-', 93) + 'AA',
    'aws-access-key-id': lambda: 'AKIA' + pick(string.ascii_uppercase + string.digits, 16),
    'stripe-secret': lambda: 'sk_live_' + pick(ALNUM, 24),
}

POSITIVE_TEMPLATES = [
    ('env-assignment', 'export {name}={value}'),
    ('yaml-pair', '{name}: {value}'),
    ('prose', 'the key is {value}, please keep it private'),
    ('bearer-header', 'curl -H "Authorization: Bearer {value}" https://api.example.test/v1/me'),
    ('json-field', '{{"{lname}": "{value}"}}'),
]
NAMES = {
    'cloudflare': 'CLOUDFLARE_API_TOKEN',
    'neon': 'NEON_API_KEY',
    'google-oauth-client-secret': 'GOOGLE_CLIENT_SECRET',
    'google-access-token': 'GOOGLE_ACCESS_TOKEN',
    'github-pat': 'GITHUB_TOKEN',
    'github-fine-grained': 'GH_FINE_TOKEN',
    'anthropic': 'ANTHROPIC_API_KEY',
    'aws-access-key-id': 'AWS_ACCESS_KEY_ID',
    'stripe-secret': 'STRIPE_SECRET_KEY',
}


def text_cases() -> list[dict]:
    cases = []
    for family, make in FAMILIES.items():
        for label, template in POSITIVE_TEMPLATES:
            value = make()
            name = NAMES[family]
            text = template.format(name=name, lname=name.lower(), value=value)
            cases.append({'id': f'{family}-{label}', 'kind': 'positive', 'family': family, 'text': text, 'secrets': [value]})
    neon_password = FAMILIES['neon']()
    cases.append({
        'id': 'neon-connection-url', 'kind': 'positive', 'family': 'neon',
        'text': f'postgresql://app_user:{neon_password}@ep-quiet-river-123456.eu-central-1.aws.neon.tech/app?sslmode=require',
        'secrets': [neon_password],
    })
    cases.append({
        'id': 'github-base64-wrapped', 'kind': 'positive', 'family': 'github-pat',
        'text': 'GH_TOKEN_B64=' + __import__('base64').b64encode((value := FAMILIES['github-pat']()).encode()).decode(),
        'secrets': [value],
    })
    cases.append({
        'id': 'anthropic-url-encoded', 'kind': 'positive', 'family': 'anthropic',
        'text': 'ANTHROPIC_QUERY=' + (value := FAMILIES['anthropic']()).replace('-', '%2D').replace('_', '%5F'),
        'secrets': [value],
    })
    return cases


NEGATIVES = [
    ('git-log-sha', 'git log --oneline\ncommit 3f6c2a9b8d1e4f7a0c5b6d9e2f1a8c7b4d3e6f09 (HEAD -> main)\nAuthor: developer'),
    ('lockfile-integrity', '"integrity": "sha512-' + pick(ALNUM + '+/', 86) + '=="'),
    ('file-path', '/home/user/projects/secret-gateway/src/detect.ts'),
    ('package-version', '"@types/node": "24.0.0", "typescript": "5.9.2"'),
    ('prose', 'Please review the pull request and rerun the tests before merging the branch.'),
    ('css-color', 'color: #1d1d1f; background: #ffffff;'),
    ('identifier', 'internationalizationResolverFactoryBuilderAdapter'),
    ('url-no-secret', 'https://docs.example.test/guides/getting-started/installation'),
]


GIT_CONTEXT = {'git-log-sha'}


def negative_cases() -> list[dict]:
    return [
        {'id': name, 'kind': 'negative', 'family': None, 'gitContext': name in GIT_CONTEXT, 'text': text, 'secrets': []}
        for name, text in NEGATIVES
    ]


def render_dashboard(path: Path, title: str, rows: list[tuple[str, str]]) -> list[list[int]]:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', 20)
    label_font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', 20)
    title_font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 26)
    image = Image.new('RGB', (1280, 800), (247, 248, 250))
    draw = ImageDraw.Draw(image)
    draw.rectangle([0, 0, 1280, 64], fill=(30, 34, 44))
    draw.text((24, 16), title, font=title_font, fill=(255, 255, 255))
    draw.rectangle([0, 64, 240, 800], fill=(236, 239, 244))
    for index, item in enumerate(['Overview', 'Workers', 'Databases', 'API tokens']):
        draw.text((24, 100 + index * 44), item, font=label_font, fill=(60, 66, 80))
    y = 120
    boxes = []
    for label, value in rows:
        draw.text((280, y), label, font=label_font, fill=(60, 66, 80))
        draw.rectangle([280, y + 34, 1220, y + 80], fill=(255, 255, 255), outline=(200, 204, 212))
        draw.text((292, y + 44), value, font=font, fill=(20, 20, 30))
        left, top, right, bottom = font.getbbox(value)
        boxes.append([292 + left, y + 44 + top, 292 + right, y + 44 + bottom])
        y += 150
    image.save(path, format='PNG')
    return boxes


def image_cases() -> list[dict]:
    cases = []
    layouts = [
        ('cloudflare-token', 'Cloudflare dashboard - API tokens', [('Token value', FAMILIES['cloudflare']())]),
        ('neon-key', 'Neon console - API keys', [('API key', FAMILIES['neon']()), ('Project', 'quiet-river-123456')]),
        ('google-client', 'Google Cloud - OAuth client', [('Client secret', FAMILIES['google-oauth-client-secret']())]),
        ('github-token', 'GitHub - Developer settings', [('Personal access token', FAMILIES['github-pat']())]),
        ('multi-key', 'Provider keys', [('Anthropic', FAMILIES['anthropic']()), ('AWS key id', FAMILIES['aws-access-key-id']())]),
    ]
    image_dir = FIXTURES / 'images'
    image_dir.mkdir(parents=True, exist_ok=True)
    for name, title, rows in layouts:
        file = f'{name}.png'
        boxes = render_dashboard(image_dir / file, title, rows)
        cases.append({'id': name, 'file': f'images/{file}', 'title': title,
                      'keys': [value for _, value in rows], 'keyBoxes': boxes})
    return cases


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    scanner = text_cases() + negative_cases()
    (FIXTURES / 'scanner-cases.json').write_text(json.dumps(scanner, indent=2, ensure_ascii=False) + '\n')
    images = image_cases()
    (FIXTURES / 'ocr-cases.json').write_text(json.dumps(images, indent=2, ensure_ascii=False) + '\n')
    print(f'wrote {len(scanner)} text cases and {len(images)} image cases to {FIXTURES}')


if __name__ == '__main__':
    main()
