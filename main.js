import marked from 'marked';
import { resolve, join, extname } from 'path';
import * as shiki from 'shiki';
import njk from 'nunjucks';
import matter from 'gray-matter';
import { minify } from 'html-minifier';

// Logging stuff
import log from 'consola';
import ora from 'ora';

import {
	readFile,
	readdir,
	exists,
	mkdirp,
	remove,
	statSync,
	outputFile,
	readFileSync,
	readdirSync,
	stat,
	copy,
} from 'fs-extra';

// CSS processing
import postcss from 'postcss';
import cssnano from 'cssnano';
import tailwind from 'tailwindcss';
import autoprefixer from 'autoprefixer';
import purgeCSS from '@fullhuman/postcss-purgecss';

// JS processing
import terser from 'terser';

// Global env
const njkRenderer = njk.configure(['layouts']);
const loader = ora();

// Bunch of utils
const [postsDir, pagesDir, distDir, layoutDir] = [
	'posts',
	'pages',
	'dist',
	'layouts',
	'assets',
].map(dir => resolve(__dirname, dir));

const resolvePost = post => resolve(postsDir, post);
const resolvePage = page => resolve(pagesDir, page);
const resolveDist = (...paths) =>
	resolve(distDir, ...paths.map(path => path.replace(/^\//, '')));
const resolveLayout = layout => resolve(layoutDir, layout);
const cssResetPath = resolve(
	__dirname,
	'node_modules/modern-css-reset/dist/reset.min.css',
);
const cssReset = readFileSync(cssResetPath, { encoding: 'utf-8' });

/* Prepend the given path segment */
const prependPathSegment = pathSegment => location =>
	join(pathSegment, location);

/* fs.readdir but with relative paths */
const readdirPreserveRelativePath = location =>
	readdirSync(location).map(prependPathSegment(location));

/* Recursive fs.readdir but with relative paths */
const readdirRecursive = location =>
	readdirPreserveRelativePath(location).reduce(
		(result, currentValue) =>
			statSync(currentValue).isDirectory()
				? result.concat(readdirRecursive(currentValue))
				: result.concat(currentValue),
		[],
	);

/*****************
 * CORE OF THE CLI
 *****************/

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

async function generatePosts() {
	// Get all the blog posts
	const postsPath = await readdir(postsDir);

	// Get the layout for the blog posts
	const blogLayout = resolveLayout('post.html');
	const layout = await readFile(blogLayout, { encoding: 'utf-8' });

	// If no blog posts, bail early
	if (!postsPath || !postsPath.length) return;

	const posts = [];

	for (const postPath of postsPath) {
		// Filter .gitkeep
		if (postPath.startsWith('.')) continue;

		const url = `/blog/${postPath.replace(/.md/i, '')}`;

		const postFile = resolvePost(postPath);

		const [content, data] = await processMarkdown(postFile);
		const [createdAt, updatedAt] = await extractStats(postFile);

		// Compile the template
		const metadata = {
			...data,
			createdAt,
			updatedAt,
			content,
			url,
		};

		const compiled = njkRenderer.renderString(layout, metadata);

		// Write the file to the dist
		await outputFile(
			resolveDist(url, 'index.html'),
			patchTemplate(compiled),
			{
				encoding: 'utf-8',
			},
		);

		posts.push(metadata);
	}

	return posts;
}

async function generateRoutes(posts) {
	// Get all the blog posts
	const pages = [];
	const pagesPath = await readdir(pagesDir);

	// If no blog posts, bail early
	if (!pagesPath || !pagesPath.length) return;

	for (const pagePath of pagesPath) {
		// Filter .gitkeep
		if (pagePath.startsWith('.')) continue;
		const pageFile = resolvePage(pagePath);

		// Get the layout for the blog posts
		const content = await readFile(pageFile, { encoding: 'utf-8' });
		const url = `/${pagePath.replace(/(index)?.html/i, '')}`;

		const metadata = {
			posts,
		};

		const compiled = njkRenderer.renderString(content, metadata);

		await outputFile(
			resolveDist(url, 'index.html'),
			patchTemplate(compiled),
			{
				encoding: 'utf-8',
			},
		);

		pages.push(content);
	}

	return pages;
}

async function processConfig(config) {
	if (!config) return;

	for (const [name, filterHandler] of Object.entries(config.filters)) {
		njkRenderer.addFilter(name, filterHandler);
	}

	return njkRenderer;
}

async function processCSSFiles(css) {
	const result = await postcss([
		tailwind(),
		autoprefixer(),
		cssnano({ preset: 'default' }),
		purgeCSS({
			content: ['./dist/**/*.html'],
			defaultExtractor: content =>
				content.match(/[A-Za-z0-9-_:/]+/g) || [],
		}),
	]).process(css, { map: false, from: null });

	return result.css;
}

function processJSFiles(js) {
	return new Promise(res => void res(terser.minify(js).code));
}

async function processAndCopyAssets() {
	const files = readdirRecursive('assets').filter(
		file => !file.includes('.gitkeep'),
	);

	for (const filePath of files) {
		loader.clear();
		log.info(`Processing ${filePath}`);

		const extension = extname(filePath);
		const file = await readFile(filePath, { encoding: 'utf-8' });
		let content = '';

		switch (extension) {
			case '.css':
				content = await processCSSFiles(file);
				break;
			case '.js':
				content = await processJSFiles(file);
				break;
			default:
				loader.clear();
				log.info(`No transformer for file type ${extension}`);
				copy(filePath, resolveDist(filePath));
				continue;
		}

		outputFile(resolveDist(filePath), content);
	}
}

async function main() {
	log.info('Starting the whole thing');

	loader.start('Cleaning up the dist folder if it exists...');
	// Rewrite the dist folder on each compilation
	if (await exists(distDir)) await remove(distDir);
	loader.succeed();

	loader.start('Resolving & processing the configuration...');
	const config = await resolveConfig();
	await processConfig(config);
	loader.succeed();

	loader.start('Creating the dist folder...');
	// Create the dist folder
	await mkdirp(distDir);
	loader.succeed();

	loader.start('Setting up the required config for the templates...');
	// Setup some highlight stuff for the markdown
	const hl = await shiki.getHighlighter({
		theme: 'nord',
	});

	marked.setOptions({
		highlight(code, lang) {
			return hl.codeToHtml(code, lang);
		},
	});
	loader.succeed();

	loader.start('Processing the blog posts...');
	// Process the posts folder
	const posts = await generatePosts();
	loader.succeed(`${posts.length} posts processed successfully`);

	loader.start('Processing the pages...');
	// Process the pages folder
	const pages = await generateRoutes(posts);
	loader.succeed(`${pages.length} pages processed successfully`);

	loader.start('Processing the assets...');
	// Process and mirror the assets directory to the dist folder
	await processAndCopyAssets();
	loader.succeed('All assets processed successfully');

	log.success(`Build successful!`);
}

// Start the small compiler
main().catch(err => console.log(err));
