import marked from 'marked';
import { resolve } from 'path';
import * as shiki from 'shiki';
import njk from 'nunjucks';
import matter from 'gray-matter';
import { minify } from 'html-minifier';

import {
	readFile,
	readdir,
	exists,
	mkdirp,
	remove,
	copy,
	outputFile,
	readFileSync,
	stat,
} from 'fs-extra';

// Global env
const njkRenderer = new njk.Environment();

// Bunch of utils
const [postsDir, distDir, layoutDir, assetsDir] = [
	'posts',
	'dist',
	'layouts',
	'assets',
].map(dir => resolve(__dirname, dir));

const resolvePost = post => resolve(postsDir, post);
const resolveDist = path => resolve(distDir, path);
const resolveLayout = layout => resolve(layoutDir, layout);
const cssResetPath = resolve(
	__dirname,
	'node_modules/modern-css-reset/dist/reset.min.css',
);
const cssReset = readFileSync(cssResetPath, { encoding: 'utf-8' });

async function resolveConfig(configName = 'config.js') {
	const configPath = resolve(__dirname, configName);
	const confExists = await exists(configPath);
	if (!confExists) return;

	return (await import(configPath)).default;
}

function patchTemplate(template) {
	// Minify the html & inject the small CSS
	return minify(
		template.replace(/<\/head>/gim, `<style>${cssReset}</style></head>`),
		{
			removeComments: true,
			collapseWhitespace: true,
			removeOptionalTags: true,
			removeRedundantAttributes: true,
			removeScriptTypeAttributes: true,
			removeTagWhitespace: true,
			useShortDoctype: true,
			minifyCSS: true,
			minifyJS: true,
		},
	);
}

async function extractStats(path) {
	const { birthtime, mtime } = await stat(path);

	return [birthtime, mtime].map(d => new Date(d));
}

async function processMarkdown(path) {
	// Get the file content
	const text = await readFile(path, { encoding: 'utf-8' });

	// Parse the front matter & then the markdown
	const { content, data } = matter(text);
	const parsed = marked.parse(content);

	return [parsed, data];
}

async function generatePosts(postsPath, layout) {
	// If no blog posts, bail early
	if (!postsPath || !postsPath.length) return;

	for (const postPath of postsPath) {
		// Filter .gitkeep
		if (postPath.startsWith('.')) continue;

		// Generate the filename by replacing the extension with html
		const filename = `blog/${postPath.replace(/md/i, 'html')}`;

		const postFile = resolvePost(postPath);

		const [content, data] = await processMarkdown(postFile);
		const [createdAt, updatedAt] = await extractStats(postFile);

		// Compile the template
		const compiled = njkRenderer.renderString(layout, {
			content,
			createdAt,
			updatedAt,
			...data,
		});

		// Write the file to the dist
		await outputFile(resolveDist(filename), patchTemplate(compiled), {
			encoding: 'utf-8',
		});
	}
}

async function processConfig(config) {
	if (!config) return;

	for (const [name, filterHandler] of Object.entries(config.filters)) {
		njkRenderer.addFilter(name, filterHandler);
	}

	return njkRenderer;
}

async function main() {
	// Rewrite the dist folder on each compilation
	if (await exists(distDir)) await remove(distDir);

	const customConfig = await resolveConfig();
	processConfig(customConfig);

	// Create the dist folder
	await mkdirp(distDir);

	// Copy the assets directory as is to the dist folder
	await copy(assetsDir, resolveDist('assets'), {
		recursive: true,
		filter: file => !file.includes('.gitkeep'),
	});

	// Setup some highlight stuff for the markdown
	const hl = await shiki.getHighlighter({
		theme: 'nord',
	});

	marked.setOptions({
		highlight(code, lang) {
			return hl.codeToHtml(code, lang);
		},
	});

	// Get all the blog posts
	const posts = await readdir(postsDir);

	// Get the layout for the blog posts
	const blogLayout = resolveLayout('post.html');
	const template = await readFile(blogLayout, { encoding: 'utf-8' });

	await generatePosts(posts, template);
}

// Start the small compiler
main().catch(err => console.log(err));
