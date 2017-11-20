function imagePromise(img){
	return new Promise(function(resolve, reject){
		img.onload = function(){
			resolve(img)
		}
		img.onerror = function(){
			reject(img)
		}
	})
};

const Ticker = {
	color: "black",
	background: "#3af",
	font: "12px sans-serif",
	width: 1000,
	
	data: async () => {
		let entries = await Database.query({read: 0, deleted: 0}).getEntries();
		entries.sort(function(a, b){
			let a_key = a.feedID;
			let b_key = b.feedID;
			if(a_key < b_key) return 1;
			if(a_key > b_key) return -1;
			return 0;
		});

		return Promise.all(entries.map((entry) => {
			const url = entry.entryURL;
			const id = entry.id;
			const feedId = entry.feedID;
			const title = entry.revisions[entry.revisions.length - 1].title;
			let img = new Image(16, 16);
			const favicon = Database.getFeed(entry.feedID).favicon;
			if (favicon == 'no-favicon') {
				img.src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==';
			} else {
				img.src = favicon;
			}

			return imagePromise(img).then((img) => {return {img, title, url, id, feedId}});
		}));
	},

	toCanvas: async (canvas) => {
		let ctx = canvas.getContext('2d');
		ctx.fillStyle = Ticker.background;
		ctx.fillRect(0, 0, canvas.width, canvas.height);

		ctx.fillStyle = Ticker.color;
		ctx.font = Ticker.font;
		let x = 0;

		const entries = await Ticker.data();

		entries.forEach((entry) => {
			ctx.drawImage(entry.img, x, 0, 16, 16);
			x+=16;
			x+=2;
			ctx.fillText(entry.title, x, 13);
			x+=ctx.measureText(entry.title).width;
			x+=4;
		});

		return ctx;
	},

	renderExternal: async () => {
		let entries = await Ticker.data();
		let firstTitle = "(up to date)";
		if (entries[0]) {
			firstTitle = entries[0].title;
		}

		//let canvas = new OffscreenCanvas(320, 16);
		let canvas = document.createElement('canvas');
		canvas.width = Ticker.width;
		canvas.height = 16;
		var ctx = await Ticker.toCanvas(canvas);

		for (let i = 0;;i++) {
			try {
				const img = {
					imageData: {
						[16]: ctx.getImageData(i*16, 0, 16, 16)
					}
				};
				await browser.runtime.sendMessage('liveticker-'+(i+1)+'@jbeekman.nl', {firstTitle, img});
			} catch(e) {
				Ticker.width = i*16;
				break;
			}
		}
	}
};
