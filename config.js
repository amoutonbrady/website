export default {
	filters: {
		date: date => {
			return date.toLocaleDateString('en-EN', {
				year: 'numeric',
				month: '2-digit',
				day: '2-digit',
			});
		},
	},
};
